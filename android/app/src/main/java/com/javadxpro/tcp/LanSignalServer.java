package com.javadxpro.tcp;

import android.content.Context;
import android.content.res.AssetManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * سرور سیگنالینگ داخل اپ (معادل server.js) — بدون هیچ وابستگی خارجی.
 * پروتکل دقیقاً همان است:
 *   ws://IP:PORT/ws?room=NAME   پیام‌های دارای target فقط به همان نفر، بقیه به کل اتاق
 *   http://IP:PORT/            صفحه‌ی برنامه (برای دوستانی که اپ ندارند و در همان وای‌فای هستند)
 *   http://IP:PORT/health      وضعیت
 */
public class LanSignalServer {

    public interface Logger { void log(String level, String text); }

    private static final int MAX_MSG = 64 * 1024;
    private static final int MAX_PER_ROOM = 30;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final Context ctx;
    private final Logger logger;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running = false;
    private int port;

    /** room -> (peerId -> client) */
    private final Map<String, Map<String, Client>> rooms = new ConcurrentHashMap<>();

    public LanSignalServer(Context ctx, Logger logger) {
        this.ctx = ctx.getApplicationContext();
        this.logger = logger;
    }

    public synchronized void start(int port) throws IOException {
        if (running) return;
        serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new java.net.InetSocketAddress("0.0.0.0", port));
        this.port = serverSocket.getLocalPort();
        running = true;
        acceptThread = new Thread(this::acceptLoop, "tcp-voice-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        log("info", "سرور سیگنالینگ روی پورت " + this.port + " گوش می‌دهد");
    }

    public synchronized void stop() {
        if (!running) return;
        running = false;
        try { serverSocket.close(); } catch (Exception ignored) { }
        for (Map<String, Client> members : rooms.values()) {
            for (Client c : members.values()) c.close(1001);
        }
        rooms.clear();
        log("dim", "سرور متوقف شد");
    }

    public boolean isRunning() { return running; }
    public int getPort() { return port; }
    public int peerCount() {
        int n = 0;
        for (Map<String, Client> m : rooms.values()) n += m.size();
        return n;
    }

    public static List<String> lanAddresses() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            if (ifs == null) return out;
            for (NetworkInterface ni : Collections.list(ifs)) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName().toLowerCase(Locale.ROOT);
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a.isLoopbackAddress() || a.getHostAddress().contains(":")) continue;
                    String ip = a.getHostAddress();
                    // هات‌اسپات/وای‌فای را جلوتر بگذار؛ اینترفیس‌های دیتا (rmnet) معمولاً از بیرون قابل‌دسترس نیستند
                    if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("swlan") || name.startsWith("eth")) out.add(0, ip);
                    else out.add(ip);
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    // ------------------------------------------------------------------

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = serverSocket.accept();
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                Thread t = new Thread(() -> handle(s), "tcp-voice-client");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (running) log("err", "accept: " + e.getMessage());
            }
        }
    }

    private void handle(Socket s) {
        Client client = null;
        try {
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            // --- خواندن هدر HTTP ---
            String reqLine = readLine(in);
            if (reqLine == null) { s.close(); return; }
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
            String[] parts = reqLine.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            String query = "";
            int q = path.indexOf('?');
            if (q >= 0) { query = path.substring(q + 1); path = path.substring(0, q); }

            String upgrade = headers.get("upgrade");
            String key = headers.get("sec-websocket-key");

            if (!"/ws".equals(path) || upgrade == null || !upgrade.equalsIgnoreCase("websocket") || key == null) {
                serveHttp(out, path);
                s.close();
                return;
            }

            // --- اتاق ---
            String room = "public";
            for (String kv : query.split("&")) {
                if (kv.startsWith("room=")) {
                    String r = java.net.URLDecoder.decode(kv.substring(5), "UTF-8").trim().toLowerCase(Locale.ROOT);
                    if (!r.isEmpty()) room = r.length() > 64 ? r.substring(0, 64) : r;
                }
            }
            Map<String, Client> members;
            synchronized (rooms) {
                members = rooms.get(room);
                if (members == null) { members = new ConcurrentHashMap<>(); rooms.put(room, members); }
            }
            if (members.size() >= MAX_PER_ROOM) {
                out.write("HTTP/1.1 503 Room Full\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                s.close();
                return;
            }

            // --- Handshake ---
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            String accept = android.util.Base64.encodeToString(
                    sha1.digest((key + WS_GUID).getBytes(StandardCharsets.US_ASCII)), android.util.Base64.NO_WRAP);
            out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();

            String id = "p_" + Long.toString((long) (Math.random() * 0x7fffffffL), 36);
            if (id.length() > 9) id = id.substring(0, 9);
            client = new Client(s, out, id, room);
            members.put(id, client);
            log("info", "+ " + id + " وارد اتاق «" + room + "» شد (" + members.size() + " نفر)");

            JSONObject init = new JSONObject();
            init.put("type", "init");
            init.put("peerId", id);
            client.send(init.toString());

            // --- حلقه‌ی فریم‌ها ---
            ByteArrayOutputStream frag = new ByteArrayOutputStream();
            while (running && !client.closed) {
                int b0 = in.read();
                if (b0 < 0) break;
                int b1 = in.read();
                if (b1 < 0) break;
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) len = ((long) in.read() << 8) | in.read();
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | in.read(); }
                if (len > MAX_MSG) { client.close(1009); break; }
                if (!masked) { client.close(1002); break; }
                byte[] mask = readFully(in, 4);
                byte[] data = readFully(in, (int) len);
                if (mask == null || data == null) break;
                for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

                if (opcode == 0x8) { client.close(1000); break; }
                if (opcode == 0x9) { client.sendRaw(0xA, data); continue; }
                if (opcode == 0xA) continue;
                if (opcode == 0x1 || opcode == 0x0) {
                    frag.write(data);
                    if (frag.size() > MAX_MSG) { client.close(1009); break; }
                    if (fin) {
                        String msg = new String(frag.toByteArray(), StandardCharsets.UTF_8);
                        frag.reset();
                        onMessage(client, msg);
                    }
                }
            }
        } catch (Exception e) {
            // اتصال قطع شد
        } finally {
            if (client != null) onClose(client);
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private void onMessage(Client c, String message) {
        JSONObject data;
        try { data = new JSONObject(message); } catch (Exception e) { return; }
        try { data.put("sender", c.id); } catch (Exception e) { return; }
        Map<String, Client> members = rooms.get(c.room);
        if (members == null) return;
        String out = data.toString();
        String target = data.optString("target", "");
        if (!target.isEmpty()) {
            Client t = members.get(target);
            if (t != null) t.send(out);
        } else {
            for (Client o : members.values()) if (o != c) o.send(out);
        }
    }

    private void onClose(Client c) {
        synchronized (c) {
            if (c.gone) return;
            c.gone = true;
            c.closed = true;
        }
        Map<String, Client> members = rooms.get(c.room);
        if (members == null) return;
        members.remove(c.id);
        String note = "{\"type\":\"peer-left\",\"sender\":\"" + c.id + "\"}";
        for (Client o : members.values()) o.send(note);
        if (members.isEmpty()) rooms.remove(c.room);
        log("dim", "- " + c.id + " از «" + c.room + "» خارج شد (" + members.size() + " نفر)");
    }

    // ------------------------------------------------------------------
    // HTTP ساده: سرو کردن صفحه‌ی برنامه از assets (public/…) تا دوستانِ بدون اپ هم بتوانند با مرورگر وارد شوند
    // ------------------------------------------------------------------
    private void serveHttp(OutputStream out, String path) throws IOException {
        if ("/health".equals(path)) {
            String body = "{\"ok\":true,\"host\":\"android\",\"rooms\":" + rooms.size() + ",\"peers\":" + peerCount() + "}";
            writeHttp(out, 200, "application/json", body.getBytes(StandardCharsets.UTF_8));
            return;
        }
        String file; String type;
        if ("/".equals(path) || "/index.html".equals(path)) { file = "public/index.html"; type = "text/html; charset=utf-8"; }
        else if ("/signal.js".equals(path)) { file = "public/signal.js"; type = "application/javascript; charset=utf-8"; }
        else if ("/manifest.json".equals(path)) { file = "public/manifest.json"; type = "application/json; charset=utf-8"; }
        else if ("/icon.svg".equals(path)) { file = "public/icon.svg"; type = "image/svg+xml; charset=utf-8"; }
        else { writeHttp(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8)); return; }
        try {
            AssetManager am = ctx.getAssets();
            InputStream is = am.open(file);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            is.close();
            writeHttp(out, 200, type, bo.toByteArray());
        } catch (IOException e) {
            writeHttp(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void writeHttp(OutputStream out, int code, String type, byte[] body) throws IOException {
        String status = code == 200 ? "OK" : "Not Found";
        out.write(("HTTP/1.1 " + code + " " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length +
                "\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) >= 0) {
            if (b == '\n') break;
            bo.write(b);
            if (bo.size() > 8192) return null;
        }
        if (b < 0 && bo.size() == 0) return null;   // EOF بدون داده
        byte[] bytes = bo.toByteArray();
        int n = bytes.length;
        if (n > 0 && bytes[n - 1] == '\r') n--;
        return new String(bytes, 0, n, StandardCharsets.ISO_8859_1);
    }

    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(b, off, n - off);
            if (r < 0) return null;
            off += r;
        }
        return b;
    }

    private void log(String level, String text) {
        if (logger != null) logger.log(level, text);
    }

    // ------------------------------------------------------------------

    private static final class Client {
        final Socket socket; final OutputStream out; final String id; final String room;
        volatile boolean closed = false; boolean gone = false;

        Client(Socket s, OutputStream out, String id, String room) {
            this.socket = s; this.out = out; this.id = id; this.room = room;
        }

        void send(String text) { sendRaw(0x1, text.getBytes(StandardCharsets.UTF_8)); }

        synchronized void sendRaw(int opcode, byte[] payload) {
            if (closed) return;
            try {
                int len = payload.length;
                byte[] head;
                if (len < 126) head = new byte[]{(byte) (0x80 | opcode), (byte) len};
                else if (len < 65536) head = new byte[]{(byte) (0x80 | opcode), 126, (byte) (len >> 8), (byte) len};
                else {
                    head = new byte[10];
                    head[0] = (byte) (0x80 | opcode); head[1] = 127;
                    for (int i = 0; i < 8; i++) head[9 - i] = (byte) ((long) len >> (8 * i));
                }
                out.write(head);
                out.write(payload);
                out.flush();
            } catch (IOException e) {
                closed = true;
                try { socket.close(); } catch (IOException ignored) { }
            }
        }

        void close(int code) {
            if (closed) return;
            sendRaw(0x8, new byte[]{(byte) (code >> 8), (byte) code});
            closed = true;
            try { socket.close(); } catch (IOException ignored) { }
        }
    }
}
