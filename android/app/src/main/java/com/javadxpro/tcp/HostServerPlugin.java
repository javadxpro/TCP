package com.javadxpro.tcp;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * پل جاوااسکریپت ← سرور سیگنالینگ داخل اپ:  window.Capacitor.Plugins.HostServer
 *   start({port}) / stop() / status()   و رویداد 'log' برای ترمینال داخل برنامه
 */
@CapacitorPlugin(name = "HostServer")
public class HostServerPlugin extends Plugin {

    // استاتیک تا با بازسازی WebView (reload) سرور از دست نرود
    private static LanSignalServer server;
    private static HostServerPlugin active;

    @Override
    public void load() {
        active = this;
    }

    private static void emitLog(String level, String text) {
        HostServerPlugin p = active;
        if (p == null) return;
        JSObject ev = new JSObject();
        ev.put("level", level);
        ev.put("text", text);
        p.notifyListeners("log", ev);
    }

    private JSObject statusObj() {
        JSObject ret = new JSObject();
        boolean running = server != null && server.isRunning();
        ret.put("running", running);
        ret.put("port", running ? server.getPort() : 0);
        ret.put("peers", running ? server.peerCount() : 0);
        JSArray addrs = new JSArray();
        if (running) {
            List<String> ips = LanSignalServer.lanAddresses();
            for (String ip : ips) addrs.put(ip);
        }
        ret.put("addresses", addrs);
        return ret;
    }

    @PluginMethod
    public void start(PluginCall call) {
        int port = call.getInt("port", 8080);
        if (port < 1024 || port > 65535) port = 8080;
        if (server == null) server = new LanSignalServer(getContext(), HostServerPlugin::emitLog);
        if (server.isRunning()) { call.resolve(statusObj()); return; }
        try {
            server.start(port);
        } catch (java.net.BindException e) {
            // پورت اشغال → پورت بعدی
            try {
                emitLog("err", "پورت " + port + " اشغال است؛ امتحان " + (port + 1));
                server.start(port + 1);
            } catch (Exception e2) {
                call.reject("پورت اشغال است: " + e2.getMessage());
                return;
            }
        } catch (Exception e) {
            call.reject("start failed: " + e.getMessage());
            return;
        }
        call.resolve(statusObj());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (server != null) server.stop();
        call.resolve(statusObj());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObj());
    }
}
