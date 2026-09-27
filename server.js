#!/usr/bin/env node
// =====================================================================
// سرور سیگنالینگ مستقل برای Termux / لینوکس / ویندوز — بدون هیچ وابستگی
// اجرا:  node server.js            (پورت پیش‌فرض 8080)
//        PORT=3000 node server.js
// پروتکل دقیقاً مثل ورکر کلادفلر (index.js) است:
//   /ws?room=NAME  ← WebSocket؛ پیام‌های دارای target فقط به همان نفر، بقیه به کل اتاق
//   /              ← صفحه index.html (برای ورود از مرورگر با http://IP:PORT)
// =====================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT || process.argv[2] || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_MSG = 64 * 1024;          // حداکثر اندازه هر پیام سیگنالینگ
const MAX_PER_ROOM = 30;

/** rooms: Map<roomName, Map<peerId, Client>> */
const rooms = new Map();
let totalBytes = 0;

// ---------------------------------------------------------------------
// فایل‌های استاتیک
// ---------------------------------------------------------------------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    const peers = [...rooms.values()].reduce((n, r) => n + r.size, 0);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers }));
  }
  const entry = STATIC[url.pathname];
  if (!entry) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(DIR, entry[0]), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------
// پیاده‌سازی حداقلی WebSocket (RFC 6455)
// ---------------------------------------------------------------------
class Client {
  constructor(socket, id, room) {
    this.socket = socket; this.id = id; this.room = room;
    this.buf = Buffer.alloc(0); this.frags = []; this.alive = true; this.closed = false;
  }
  sendRaw(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    totalBytes += head.length + len;
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(obj) { this.sendRaw(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.sendRaw(0x8, p);
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
  feed(chunk) {
    totalBytes += chunk.length;
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG) return this.close(1009);
      if (!masked) return this.close(1002);          // کلاینت باید ماسک بزند
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) return this.close();               // close
      if (opcode === 0x9) { this.sendRaw(0xA, data); continue; } // ping → pong
      if (opcode === 0xA) { this.alive = true; continue; }      // pong
      if (opcode === 0x1 || opcode === 0x0) {
        this.frags.push(data);
        if (fin) {
          const msg = Buffer.concat(this.frags).toString('utf8');
          this.frags = [];
          onMessage(this, msg);
        }
      }
    }
  }
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const rawRoom = url.searchParams.get('room');
  const room = (rawRoom && rawRoom.trim()) ? rawRoom.trim().toLowerCase().slice(0, 64) : 'public';
  const members = rooms.get(room) || new Map();
  if (members.size >= MAX_PER_ROOM) { socket.end('HTTP/1.1 503 Room Full\r\n\r\n'); return; }

  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 20000);

  const id = 'p_' + crypto.randomBytes(4).toString('hex').slice(0, 7);
  const client = new Client(socket, id, room);
  members.set(id, client);
  rooms.set(room, members);
  log(`+ ${id} وارد اتاق «${room}» شد (${members.size} نفر)`);

  client.send({ type: 'init', peerId: id });

  socket.on('data', (c) => { try { client.feed(c); } catch (e) { client.close(1011); } });
  socket.on('close', () => onClose(client));
  socket.on('error', () => onClose(client));
});

function onMessage(client, message) {
  let data;
  try { data = JSON.parse(message); } catch { return; }
  if (!data || typeof data !== 'object') return;
  data.sender = client.id;                       // شناسه امن سروری
  const members = rooms.get(client.room);
  if (!members) return;
  const out = JSON.stringify(data);
  if (data.target) {
    const t = members.get(data.target);
    if (t) t.send(out);
  } else {
    for (const [pid, c] of members) if (pid !== client.id) c.send(out);
  }
}

function onClose(client) {
  if (client.gone) return;
  client.gone = true; client.closed = true;
  const members = rooms.get(client.room);
  if (!members) return;
  members.delete(client.id);
  for (const c of members.values()) c.send({ type: 'peer-left', sender: client.id });
  if (members.size === 0) rooms.delete(client.room);
  log(`- ${client.id} از «${client.room}» خارج شد (${members.size} نفر)`);
}

// پینگ هر ۳۰ ثانیه برای تشخیص اتصال‌های مرده (چند بایت؛ مصرف ناچیز)
setInterval(() => {
  for (const members of rooms.values()) {
    for (const c of members.values()) {
      if (!c.alive) { c.socket.destroy(); onClose(c); continue; }
      c.alive = false;
      c.sendRaw(0x9, Buffer.alloc(0));
    }
  }
}, 30000).unref();

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log('\n🎮 سرور سیگنالینگ چت صوتی روشن شد');
  console.log('──────────────────────────────────────');
  const ips = lanAddresses();
  if (ips.length === 0) console.log(`  http://127.0.0.1:${PORT}`);
  for (const { name, ip } of ips) console.log(`  📋 آدرس برای بچه‌ها:  ${ip}:${PORT}   (${name})`);
  console.log('──────────────────────────────────────');
  console.log('  • در اپ: آدرس بالا را کپی کنید تا خودکار پر شود.');
  console.log(`  • در مرورگر (همان وای‌فای): http://<IP>:${PORT}`);
  console.log('  • برای توقف: Ctrl+C\n');
});

process.on('SIGINT', () => {
  console.log(`\nخاموش شد. مصرف کل سیگنالینگ: ${(totalBytes / 1024).toFixed(1)} KB`);
  process.exit(0);
});
