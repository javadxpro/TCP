export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ۱. مسیریابی مانیفست PWA برای PWABuilder
    if (url.pathname === '/manifest.json') {
      const manifest = {
        name: "Gaming Voice & Text Chat",
        short_name: "GamingVoice",
        description: "سیستم چت صوتی و متنی سبک و سریع برای بازی‌های آنلاین گروهی",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        icons: [
          {
            src: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' fill='%230f172a'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='250' fill='%2338bdf8'>🎮</text></svg>",
            sizes: "512x512",
            type: "image/svg+xml"
          }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      });
    }

    // ۲. مسیر اتصال WebSocket
    if (url.pathname === '/ws') {
      const roomId = url.searchParams.get('room') || 'default';
      const id = env.CHAT_ROOM.idFromName(roomId);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    // ۳. سرو کردن فرانت‌اند HTML
    return new Response(htmlContent, {
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  }
};

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const peerId = 'user_' + Math.random().toString(36).substring(2, 7);
    this.state.acceptWebSocket(server, [peerId]);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const tags = this.state.getTags(ws);
    const peerId = tags[0] || 'unknown';

    let data;
    try {
      data = JSON.parse(message);
    } catch(e) { return; }

    data.sender = peerId;

    for (const socket of this.state.getWebSockets()) {
      if (socket !== ws) {
        try {
          socket.send(JSON.stringify(data));
        } catch (e) {}
      }
    }
  }

  async webSocketClose(ws) {
    const tags = this.state.getTags(ws);
    const peerId = tags[0];

    for (const socket of this.state.getWebSockets()) {
      if (socket !== ws) {
        try {
          socket.send(JSON.stringify({ type: 'peer-left', sender: peerId }));
        } catch (e) {}
      }
    }
  }
}

const htmlContent = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="manifest" href="/manifest.json">
  <title>🎮 چت و ویس گیمینگ چندنفره</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    body { background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { width: 100%; max-width: 500px; background: #1e293b; padding: 20px; border-radius: 14px; box-shadow: 0 8px 20px rgba(0,0,0,0.4); }
    h2 { text-align: center; margin-top: 0; color: #38bdf8; font-size: 20px; }
    .flex { display: flex; gap: 8px; margin-bottom: 12px; }
    input, button { padding: 10px 14px; border-radius: 8px; border: 1px solid #334155; font-size: 14px; outline: none; }
    input { background: #0f172a; color: #fff; flex: 1; }
    button { background: #2563eb; color: #fff; border: none; cursor: pointer; font-weight: bold; }
    button:hover { background: #1d4ed8; }
    .btn-danger { background: #ef4444; }
    .btn-danger:hover { background: #dc2626; }
    .btn-success { background: #22c55e; }
    .btn-success:hover { background: #16a34a; }
    .section-title { font-size: 13px; color: #94a3b8; margin: 12px 0 6px 0; font-weight: 600; display: flex; justify-content: space-between; }
    #peers-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .peer-chip { background: #0f172a; border: 1px solid #334155; padding: 4px 10px; border-radius: 20px; font-size: 12px; color: #38bdf8; }
    #chat-box { height: 200px; background: #0f172a; border-radius: 8px; padding: 10px; overflow-y: auto; border: 1px solid #334155; margin-bottom: 10px; display: flex; flex-direction: column; gap: 6px; }
    .msg { font-size: 13px; line-height: 1.4; word-break: break-word; }
    .msg .sender { font-weight: bold; color: #38bdf8; margin-left: 4px; }
    .msg.system { color: #64748b; font-style: italic; font-size: 12px; }
  </style>
</head>
<body>

<div class="card" onclick="enableAudioPlayback()">
  <h2>🎮 چت و ویس گیمینگ</h2>

  <div id="join-form" class="flex">
    <input id="username" placeholder="نام شما" value="بازیکن ۱">
    <input id="room" placeholder="روم" value="team1" style="max-width: 100px;">
    <button onclick="connect()">ورود</button>
  </div>

  <div id="room-panel" style="display: none;">
    <div class="flex" style="justify-content: space-between;">
      <button id="mic-btn" class="btn-danger" onclick="toggleMic()">🎙️ میکروفون: خاموش</button>
      <button class="btn-danger" style="background:#475569;" onclick="location.reload()">خروج</button>
    </div>

    <div class="section-title">
      <span>اعضای حاضر در روم:</span>
      <span id="peer-count">1 نفر</span>
    </div>
    <div id="peers-list">
      <div class="peer-chip">👤 شما (<span id="my-name"></span>)</div>
    </div>

    <div class="section-title">💬 چت متنی</div>
    <div id="chat-box"></div>

    <form class="flex" onsubmit="sendMessage(event)">
      <input id="chat-input" placeholder="پیام خود را بنویسید..." autocomplete="off">
      <button type="submit">ارسال</button>
    </form>
  </div>
</div>

<div id="audio-container"></div>

<script>
  let ws, localStream;
  const peers = {};
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.services.mozilla.com' }
    ]
  };

  function enableAudioPlayback() {
    const audios = document.querySelectorAll('audio');
    audios.forEach(a => a.play().catch(() => {}));
  }

  function connect() {
    enableAudioPlayback();
    const username = document.getElementById('username').value.trim() || 'بازیکن';
    const room = document.getElementById('room').value.trim() || 'default';
    document.getElementById('my-name').innerText = username;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(\`\${protocol}//\${location.host}/ws?room=\${room}\`);

    ws.onopen = () => {
      document.getElementById('join-form').style.display = 'none';
      document.getElementById('room-panel').style.display = 'block';
      addSystemMsg(\`وارد روم [\${room}] شدید.\`);
      ws.send(JSON.stringify({ type: 'join', name: username }));
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      handleSignalMessage(msg);
    };

    ws.onclose = () => addSystemMsg("اتصال قطع شد.");
  }

  async function handleSignalMessage(msg) {
    const sender = msg.sender;

    switch (msg.type) {
      case 'join':
        addSystemMsg(\`\${msg.name} وارد شد.\`);
        ws.send(JSON.stringify({ type: 'welcome', name: document.getElementById('username').value }));
        updatePeerList(sender, msg.name);
        initPeerConnection(sender, msg.name, true);
        break;

      case 'welcome':
        updatePeerList(sender, msg.name);
        initPeerConnection(sender, msg.name, false);
        break;

      case 'chat':
        addChatMsg(msg.name, msg.text);
        break;

      case 'offer':
        const pc = initPeerConnection(sender, msg.name, false);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', target: sender, sdp: answer }));
        break;

      case 'answer':
        if (peers[sender]?.pc) {
          await peers[sender].pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
        break;

      case 'ice':
        if (peers[sender]?.pc) {
          try { await peers[sender].pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) {}
        }
        break;

      case 'peer-left':
        removePeer(sender);
        break;
    }
  }

  function initPeerConnection(peerId, peerName, isInitiator) {
    if (peers[peerId]?.pc) return peers[peerId].pc;

    const pc = new RTCPeerConnection(rtcConfig);
    peers[peerId] = { pc, name: peerName };

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
      let audioEl = document.getElementById(\`audio-\${peerId}\`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = \`audio-\${peerId}\`;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        document.getElementById('audio-container').appendChild(audioEl);
      }
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(e => console.log("Autoplay check:", e));
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({ type: 'ice', target: peerId, candidate: event.candidate }));
      }
    };

    if (isInitiator) {
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', target: peerId, sdp: offer, name: document.getElementById('username').value }));
      });
    }

    return pc;
  }

  async function toggleMic() {
    enableAudioPlayback();
    const btn = document.getElementById('mic-btn');

    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
        });
        btn.innerText = "🎙️ میکروفون: روشن";
        btn.className = "btn-success";

        Object.keys(peers).forEach(peerId => {
          const pc = peers[peerId].pc;
          localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
          pc.createOffer().then(offer => {
            pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', target: peerId, sdp: offer, name: document.getElementById('username').value }));
          });
        });

      } catch (err) {
        alert("خطا در دسترسی به میکروفون!");
      }
    } else {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
      btn.innerText = "🎙️ میکروفون: خاموش";
      btn.className = "btn-danger";
    }
  }

  function sendMessage(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const name = document.getElementById('username').value.trim();

    if (text && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', name, text }));
      addChatMsg('شما', text);
      input.value = '';
    }
  }

  function addChatMsg(sender, text) {
    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = \`<span class="sender">\${sender}:</span> \${escapeHtml(text)}\`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function addSystemMsg(text) {
    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerText = \`• \${text}\`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function updatePeerList(peerId, peerName) {
    if (!document.getElementById(\`peer-\${peerId}\`)) {
      const list = document.getElementById('peers-list');
      const chip = document.createElement('div');
      chip.className = 'peer-chip';
      chip.id = \`peer-\${peerId}\`;
      chip.innerText = \`👤 \${peerName}\`;
      list.appendChild(chip);
      document.getElementById('peer-count').innerText = \`\${list.children.length} نفر\`;
    }
  }

  function removePeer(peerId) {
    if (peers[peerId]) {
      if (peers[peerId].pc) peers[peerId].pc.close();
      delete peers[peerId];
    }
    const chip = document.getElementById(\`peer-\${peerId}\`);
    if (chip) chip.remove();
    const audioEl = document.getElementById(\`audio-\${peerId}\`);
    if (audioEl) audioEl.remove();
    document.getElementById('peer-count').innerText = \`\${document.getElementById('peers-list').children.length} نفر\`;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
</script>
</body>
</html>`;