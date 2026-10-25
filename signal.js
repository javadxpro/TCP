/*!
 * TCPSignal — لایه‌ی سیگنالینگ سبک و بدون وابستگی (همان لایه‌ای که چت صوتی TCP استفاده می‌کند)
 *
 * دو ترنسپورت:
 *   • WebSocket  → سرور کلادفلر / server.js / سرور داخل اپ اندروید
 *   • MQTT 3.1.1 روی WebSocket → بروکر عمومی؛ «بدون سرور»
 *
 * استفاده‌ی سطح پایین (همان پروتکل چت صوتی: init / پیام‌های target‌دار / peer-left):
 *   const t = TCPSignal.connectMqtt('room', { onOpen, onMessage, onClose });
 *   t.send({ type: 'hello', target: 'p_xxx' });  t.close();
 *
 * استفاده‌ی سطح بالا (برای اشتراک صفحه، ارسال فایل، چت، …):
 *   const room = TCPSignal.createRoom('my-room', { mode: 'mqtt' });   // یا { mode: 'ws', url: 'ws://IP:8080' }
 *   room.on('ready',       ({ id }) => …)            // شناسه‌ی خودم
 *   room.on('peer-joined', ({ id, meta }) => …)      // هم‌زمان برای تازه‌وارد و قدیمی‌ها
 *   room.on('peer-left',   ({ id }) => …)
 *   room.on('message',     ({ from, data }) => …)    // هر پیام دلخواه
 *   room.on('close',       ({ reason }) => …)
 *   room.send(data)            // به همه
 *   room.send(data, peerId)    // فقط به یک نفر
 *   room.peers                 // Map<id, meta>
 *   room.close()
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TCPSignal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONNECT_TIMEOUT = 8000;
  const DEFAULT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const randomId = () => 'p_' + Math.random().toString(36).slice(2, 9);

  // ---------- ترنسپورت ۱: WebSocket ----------
  function connectWebSocket(url, h) {
    const t = { open: false, kind: 'ws', ws: null, url,
      send(obj) { this.ws.send(JSON.stringify(obj)); },
      close() { closedReported = true; this.open = false; clearTimeout(timer); try { this.ws && this.ws.close(); } catch (e) {} } };
    let timer = null, closedReported = false;
    const report = (r) => { if (closedReported) return; closedReported = true; t.open = false; clearTimeout(timer); h.onClose && h.onClose(r); };
    try { t.ws = new WebSocket(url); } catch (e) { setTimeout(() => report('bad-url'), 0); return t; }
    timer = setTimeout(() => { if (!t.open) { try { t.ws.close(); } catch (e) {} report('timeout'); } }, CONNECT_TIMEOUT);
    t.ws.onopen = () => { clearTimeout(timer); t.open = true; h.onOpen && h.onOpen(); };
    t.ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } h.onMessage && h.onMessage(m); };
    t.ws.onclose = () => report('closed');
    t.ws.onerror = () => { if (!t.open && !closedReported) { closedReported = true; try { t.ws.close(); } catch (e) {} closedReported = false; report('error'); } };
    return t;
  }

  // ---------- ترنسپورت ۲: MQTT 3.1.1 حداقلی ----------
  const enc = new TextEncoder(), dec = new TextDecoder();
  function mqttStr(s) { const b = enc.encode(s); const out = new Uint8Array(2 + b.length); out[0] = b.length >> 8; out[1] = b.length & 255; out.set(b, 2); return out; }
  function mqttPacket(type, flags, ...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const rl = []; let x = len; do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; rl.push(d); } while (x > 0);
    const out = new Uint8Array(1 + rl.length + len); out[0] = (type << 4) | flags; out.set(rl, 1);
    let o = 1 + rl.length; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function topicBase(prefix, room) {
    const safe = encodeURIComponent(String(room).toLowerCase()).replace(/[%+#/]/g, '_');
    return prefix + '/' + safe;
  }

  /**
   * @param room   نام اتاق
   * @param h      { onOpen, onMessage, onClose }
   * @param opts   { brokers: string[], prefix: 'tcpvoice/v1', peerId }
   */
  function connectMqtt(room, h, opts) {
    opts = opts || {};
    const brokers = (opts.brokers && opts.brokers.length) ? opts.brokers.slice() : DEFAULT_BROKERS.slice();
    const base = topicBase(opts.prefix || 'tcpvoice/v1', room);
    const myId = opts.peerId || randomId();
    const topicAll = base + '/all', topicMe = base + '/p/' + myId;
    const t = { open: false, kind: 'mqtt', ws: null, dead: false, broker: null, peerId: myId,
      send(obj) {
        obj.sender = myId;
        const topic = obj.target ? base + '/p/' + obj.target : topicAll;
        this.ws.send(mqttPacket(3, 0, mqttStr(topic), enc.encode(JSON.stringify(obj))));
      },
      close() {
        this.dead = true; this.open = false; clearInterval(ping); clearTimeout(timer);
        try {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(mqttPacket(3, 0, mqttStr(topicAll), enc.encode(JSON.stringify({ type: 'peer-left', sender: myId }))));
            this.ws.send(mqttPacket(14, 0)); // DISCONNECT
          }
          this.ws && this.ws.close();
        } catch (e) {}
      } };
    let ping = null, timer = null, idx = 0, buf = new Uint8Array(0);

    function tryNext(reason) {
      if (t.dead) return;
      clearInterval(ping); clearTimeout(timer); buf = new Uint8Array(0);
      if (idx >= brokers.length) { t.open = false; h.onClose && h.onClose(reason || 'no-broker'); return; }
      const url = brokers[idx++];
      t.broker = url;
      let ws;
      try { ws = new WebSocket(url, 'mqtt'); } catch (e) { return tryNext('bad-url'); }
      ws.binaryType = 'arraybuffer';
      t.ws = ws;
      let connected = false;
      timer = setTimeout(() => { if (!connected) { try { ws.close(); } catch (e) {} } }, CONNECT_TIMEOUT);
      ws.onopen = () => {
        // CONNECT: clean session، keepalive 30s، Last Will = peer-left
        const will = JSON.stringify({ type: 'peer-left', sender: myId });
        ws.send(mqttPacket(1, 0, mqttStr('MQTT'), Uint8Array.of(4, 0x02 | 0x04, 0, 30),
          mqttStr('tcpv_' + myId), mqttStr(topicAll), mqttStr(will)));
      };
      ws.onmessage = (e) => {
        const chunk = new Uint8Array(e.data);
        const nb = new Uint8Array(buf.length + chunk.length); nb.set(buf); nb.set(chunk, buf.length); buf = nb;
        while (buf.length >= 2) {
          let mult = 1, len = 0, pos = 1, d;
          do { if (pos >= buf.length) return; d = buf[pos++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
          if (buf.length < pos + len) return;
          const type = buf[0] >> 4, qos = (buf[0] >> 1) & 3, body = buf.subarray(pos, pos + len);
          buf = buf.slice(pos + len);
          if (type === 2) {           // CONNACK
            if (body[1] !== 0) { ws.close(); return; }
            ws.send(mqttPacket(8, 2, Uint8Array.of(0, 1), mqttStr(topicAll), Uint8Array.of(0), mqttStr(topicMe), Uint8Array.of(0)));
          } else if (type === 9) {    // SUBACK
            if (connected) continue;
            connected = true; clearTimeout(timer); t.open = true;
            ping = setInterval(() => { try { ws.send(mqttPacket(12, 0)); } catch (e) {} }, 15000);
            h.onOpen && h.onOpen();
            h.onMessage && h.onMessage({ type: 'init', peerId: myId });
          } else if (type === 3) {    // PUBLISH
            const tl = (body[0] << 8) | body[1];
            let off = 2 + tl; if (qos) off += 2;
            let msg; try { msg = JSON.parse(dec.decode(body.subarray(off))); } catch (err) { continue; }
            if (!msg || msg.sender === myId) continue;
            if (msg.target && msg.target !== myId) continue;
            h.onMessage && h.onMessage(msg);
          }
        }
      };
      let ended = false;
      const ended_ = () => {
        if (ended) return; ended = true;
        clearInterval(ping); clearTimeout(timer);
        if (t.dead) return;
        if (!connected) tryNext('broker-failed');
        else { t.open = false; h.onClose && h.onClose('closed'); }
      };
      ws.onerror = () => { if (!connected && !ended) { const f = ended_; ended = true; try { ws.close(); } catch (e) {} ended = false; f(); } };
      ws.onclose = ended_;
    }
    tryNext();
    return t;
  }

  // ---------- API سطح بالا: اتاق با فهرست اعضا ----------
  /**
   * @param name  نام اتاق
   * @param opts  { mode: 'mqtt'|'ws', url (برای ws: ws://IP:PORT یا آدرس کامل /ws?room=), brokers, prefix, meta }
   */
  function createRoom(name, opts) {
    opts = opts || {};
    const listeners = {};
    const peers = new Map();
    const room = {
      id: null, peers, transport: null, closed: false,
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return room; },
      off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); return room; },
      send(data, target) { if (!room.transport || !room.transport.open) return false; const m = { type: 'msg', data }; if (target) m.target = target; room.transport.send(m); return true; },
      close() { room.closed = true; if (room.transport) room.transport.close(); emit('close', { reason: 'closed' }); },
    };
    const emit = (ev, arg) => (listeners[ev] || []).forEach(fn => { try { fn(arg); } catch (e) { console.error(e); } });
    const meta = opts.meta || {};
    const handlers = {
      onMessage(msg) {
        const from = msg.sender;
        switch (msg.type) {
          case 'init':
            room.id = msg.peerId;
            room.transport.send({ type: 'join', meta });
            emit('ready', { id: room.id });
            break;
          case 'join':
            peers.set(from, msg.meta || {});
            room.transport.send({ type: 'welcome', target: from, meta });
            emit('peer-joined', { id: from, meta: msg.meta || {}, initiator: true });
            break;
          case 'welcome':
            if (!peers.has(from)) { peers.set(from, msg.meta || {}); emit('peer-joined', { id: from, meta: msg.meta || {}, initiator: false }); }
            break;
          case 'peer-left':
            if (peers.delete(from)) emit('peer-left', { id: from });
            break;
          case 'msg':
            emit('message', { from, data: msg.data });
            break;
          default:
            emit('raw', msg);
        }
      },
      onClose(reason) { if (!room.closed) { room.closed = true; emit('close', { reason }); } },
      onOpen() {},
    };
    if (opts.mode === 'ws') {
      let url = opts.url || '';
      if (!/\/ws(\?|$)/.test(url)) {
        url = url.replace(/\/$/, '');
        if (!/^wss?:\/\//.test(url)) url = (/^(\d{1,3}(\.\d{1,3}){3}|localhost)(:\d+)?$/.test(url) ? 'ws://' : 'wss://') + url;
        url += '/ws?room=' + encodeURIComponent(name);
      }
      room.transport = connectWebSocket(url, handlers);
    } else {
      room.transport = connectMqtt(name, handlers, { brokers: opts.brokers, prefix: opts.prefix || 'tcpsignal/v1' });
    }
    return room;
  }

  return { connectWebSocket, connectMqtt, createRoom, DEFAULT_BROKERS, CONNECT_TIMEOUT, randomId };
});
