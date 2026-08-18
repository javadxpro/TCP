// ==================== ChatGram - Cloudflare Worker ====================

let chatClients = new Set();

// ===== Durable Object برای اتاق صوتی =====

export class VoiceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");

    if (upgrade === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      this.clients.add(server);

      server.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          for (const client of this.clients) {
            if (client !== server && client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'voice',
                data: data
              }));
            }
          }
        } catch (e) {
          console.warn('Voice error:', e);
        }
      });

      server.addEventListener("close", () => {
        this.clients.delete(server);
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Voice Room WebSocket", { status: 400 });
  }
}

// ===== Worker اصلی =====

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ===== API ها =====

    // دریافت پیام‌های ذخیره شده از KV
    if (path === '/api/messages' && request.method === 'GET') {
      try {
        const messages = await env.VL_DB.get('messages', 'json') || [];
        return Response.json(messages.slice(-100));
      } catch (e) {
        return Response.json([]);
      }
    }

    // دریافت تعداد کاربران آنلاین
    if (path === '/api/online' && request.method === 'GET') {
      return Response.json({ count: chatClients.size + 1 });
    }

    // ===== WebSocket چت =====

    if (path === '/ws/chat') {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return new Response("WebSocket required", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      chatClients.add(server);

      server.addEventListener("message", async (event) => {
        try {
          const data = JSON.parse(event.data);

          // پیام خوش‌آمدگویی
          if (data.type === 'welcome') {
            const messages = await env.VL_DB.get('messages', 'json') || [];
            const welcomeMsg = {
              id: Date.now(),
              sender: data.sender,
              text: data.text,
              timestamp: data.timestamp,
              type: 'welcome'
            };
            messages.push(welcomeMsg);
            if (messages.length > 500) {
              messages.splice(0, messages.length - 500);
            }
            await env.VL_DB.put('messages', JSON.stringify(messages));

            for (const client of chatClients) {
              if (client.readyState === 1) {
                client.send(JSON.stringify(welcomeMsg));
              }
            }
            return;
          }

          // پیام معمولی
          if (data.type === 'message') {
            const messages = await env.VL_DB.get('messages', 'json') || [];
            const newMsg = {
              id: Date.now(),
              sender: data.sender,
              text: data.text,
              timestamp: data.timestamp || new Date().toISOString(),
              type: 'message'
            };
            messages.push(newMsg);
            if (messages.length > 500) {
              messages.splice(0, messages.length - 500);
            }
            await env.VL_DB.put('messages', JSON.stringify(messages));

            for (const client of chatClients) {
              if (client !== server && client.readyState === 1) {
                client.send(JSON.stringify(newMsg));
              }
            }
          }
        } catch (e) {
          console.warn('Chat error:', e);
        }
      });

      server.addEventListener("close", () => {
        chatClients.delete(server);
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // ===== WebSocket اتاق صوتی =====

    if (path.startsWith('/ws/voice/')) {
      const roomId = path.split('/')[3] || 'default';
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return new Response("WebSocket required", { status: 400 });
      }

      const id = env.VOICE_ROOMS.idFromName(roomId);
      const obj = env.VOICE_ROOMS.get(id);
      return obj.fetch(request);
    }

    // ===== صفحات HTML/CSS/JS =====

    if (path === '/' || path === '/index.html') {
      return new Response(await getIndexHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/style.css') {
      return new Response(await getStyleCSS(), {
        headers: { 'Content-Type': 'text/css; charset=utf-8' }
      });
    }

    if (path === '/script.js') {
      return new Response(await getScriptJS(), {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ==================== HTML ====================

async function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>💬 چتگرام</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <header>
        <h1>💬 چتگرام</h1>
        <span id="onlineCount">👤 ۰ آنلاین</span>
    </header>
    
    <main>
        <div class="chat-container">
            <div class="messages" id="messagesContainer"></div>
            <div class="input-area">
                <input type="text" id="messageInput" placeholder="پیام بنویسید..." onkeypress="if(event.key==='Enter') sendMessage()">
                <button onclick="sendMessage()">📤</button>
            </div>
        </div>
    </main>

    <!-- دکمه بزرگ قطع/وصل صوتی -->
    <button id="bigVoiceBtn" onclick="toggleVoice()">🎙️ اتصال صوتی</button>

    <script src="/script.js"></script>
</body>
</html>`;
}

// ==================== CSS ====================

async function getStyleCSS() {
  return `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

body {
  background: #0F0E1A;
  color: #FFFFFF;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

header {
  background: #1A1932;
  padding: 12px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}

header h1 {
  font-size: 18px;
  font-weight: 700;
  background: linear-gradient(135deg, #7B6BAA, #C084FC);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

#onlineCount {
  font-size: 13px;
  color: #A0A0C0;
}

main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #0F0E1A;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.message {
  max-width: 80%;
  padding: 8px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  animation: fadeIn 0.25s ease;
}

.message.sent {
  background: #5B4B8A;
  color: white;
  align-self: flex-end;
  border-bottom-right-radius: 4px;
}

.message.received {
  background: #1A1932;
  border: 1px solid rgba(255,255,255,0.08);
  align-self: flex-start;
  border-bottom-left-radius: 4px;
}

.message .sender {
  font-size: 11px;
  font-weight: 700;
  color: #7B6BAA;
  margin-bottom: 2px;
  display: block;
}

.message.sent .sender {
  color: rgba(255,255,255,0.7);
}

.message .time {
  font-size: 9px;
  color: #A0A0C0;
  margin-top: 3px;
  display: block;
  text-align: left;
}

.message.sent .time {
  color: rgba(255,255,255,0.5);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.input-area {
  padding: 12px 16px;
  background: #1A1932;
  border-top: 1px solid rgba(255,255,255,0.08);
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
}

.input-area input {
  flex: 1;
  padding: 10px 16px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 24px;
  background: #0F0E1A;
  color: #FFFFFF;
  outline: none;
  font-size: 14px;
}

.input-area input:focus {
  border-color: #5B4B8A;
}

.input-area input::placeholder {
  color: #666;
}

.input-area button {
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 50%;
  background: #5B4B8A;
  color: white;
  font-size: 18px;
  cursor: pointer;
  flex-shrink: 0;
}

.input-area button:hover {
  background: #7B6BAA;
}

/* ===== دکمه بزرگ قطع/وصل صوتی ===== */
#bigVoiceBtn {
  position: fixed;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  background: #5B4B8A;
  color: white;
  border: none;
  padding: 18px 44px;
  border-radius: 50px;
  font-size: 22px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 8px 32px rgba(91, 75, 138, 0.5);
  z-index: 999;
  transition: all 0.3s;
  min-width: 220px;
  text-align: center;
  letter-spacing: 1px;
}

#bigVoiceBtn:hover {
  transform: translateX(-50%) scale(1.05);
  background: #7B6BAA;
}

#bigVoiceBtn.active {
  background: #EF4444;
  box-shadow: 0 8px 32px rgba(239, 68, 68, 0.5);
}

#bigVoiceBtn.active:hover {
  background: #DC2626;
}

/* موبایل */
@media (max-width: 768px) {
  #bigVoiceBtn {
    bottom: 70px;
    padding: 14px 28px;
    font-size: 18px;
    min-width: 160px;
  }
}

::-webkit-scrollbar {
  width: 3px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.1);
  border-radius: 4px;
}`;
}

// ==================== JavaScript ====================

async function getScriptJS() {
  return `// ====== چتگرام - سمت کلاینت ======

let ws = null;
let voiceWs = null;
let voiceStream = null;
let username = prompt('نام خود را وارد کنید:', 'کاربر') || 'ناشناس';
let isVoiceConnected = false;
let reconnectAttempts = 0;
let audioContext = null;
let processor = null;

// ===== اتصال به چت =====

function connectChat() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  
  ws = new WebSocket(\`\${protocol}//\${host}/ws/chat\`);
  
  ws.onopen = () => {
    console.log('✅ چت متصل شد');
    reconnectAttempts = 0;
    
    // بارگذاری پیام‌های قبلی از KV
    loadMessages();
    
    // ارسال پیام خوش‌آمدگویی
    ws.send(JSON.stringify({
      type: 'welcome',
      sender: 'ربات',
      text: \`👋 \${username} به چتگرام خوش آمدید!\`,
      timestamp: new Date().toISOString()
    }));
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      appendMessage(data);
    } catch (e) {
      console.warn('خطا:', e);
    }
  };
  
  ws.onclose = () => {
    console.log('❌ چت قطع شد، تلاش مجدد...');
    reconnectAttempts++;
    setTimeout(connectChat, Math.min(3000 * reconnectAttempts, 30000));
  };
}

// ===== بارگذاری پیام‌های قبلی از KV =====

function loadMessages() {
  fetch('/api/messages')
    .then(res => res.json())
    .then(messages => {
      const container = document.getElementById('messagesContainer');
      container.innerHTML = '';
      messages.forEach(appendMessage);
    })
    .catch(() => {});
}

// ===== ارسال پیام =====

function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  
  ws.send(JSON.stringify({
    type: 'message',
    sender: username,
    text: text,
    timestamp: new Date().toISOString()
  }));
  
  input.value = '';
}

// ===== نمایش پیام =====

function appendMessage(msg) {
  const container = document.getElementById('messagesContainer');
  const isSent = msg.sender === username;
  const div = document.createElement('div');
  div.className = \`message \${isSent ? 'sent' : 'received'}\`;
  
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('fa-IR') : 'همین الان';
  
  div.innerHTML = \`
    <span class="sender">\${msg.sender || 'ناشناس'}</span>
    \${msg.text || ''}
    <span class="time">\${time}</span>
  \`;
  
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ===== تعداد آنلاین =====

function updateOnlineCount() {
  fetch('/api/online')
    .then(res => res.json())
    .then(data => {
      document.getElementById('onlineCount').textContent = \`👤 \${data.count || 0} آنلاین\`;
    })
    .catch(() => {});
}

// ===== دکمه بزرگ قطع/وصل صوتی =====

async function toggleVoice() {
  const btn = document.getElementById('bigVoiceBtn');
  
  if (isVoiceConnected) {
    // قطع اتصال
    if (voiceWs) voiceWs.close();
    if (voiceStream) {
      voiceStream.getTracks().forEach(track => track.stop());
      voiceStream = null;
    }
    if (processor) {
      processor.disconnect();
      processor = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
      audioContext = null;
    }
    isVoiceConnected = false;
    btn.textContent = '🎙️ اتصال صوتی';
    btn.classList.remove('active');
    return;
  }
  
  // اتصال صوتی
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    
    voiceWs = new WebSocket(\`\${protocol}//\${host}/ws/voice/default\`);
    
    voiceWs.onopen = () => {
      isVoiceConnected = true;
      btn.textContent = '🔴 قطع صوتی';
      btn.classList.add('active');
      
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(voiceStream);
      processor = audioContext.createScriptProcessor(2048, 1, 1);
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      let lastSend = 0;
      processor.onaudioprocess = (e) => {
        const now = Date.now();
        if (now - lastSend > 80 && voiceWs && voiceWs.readyState === 1) {
          lastSend = now;
          const inputData = e.inputBuffer.getChannelData(0);
          const sampleRate = 4;
          const sampled = [];
          for (let i = 0; i < inputData.length; i += sampleRate) {
            sampled.push(inputData[i]);
          }
          voiceWs.send(JSON.stringify({
            type: 'audio',
            data: sampled
          }));
        }
      };
    };
    
    voiceWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'voice' || data.type === 'audio') {
          if (audioContext && audioContext.state !== 'closed') {
            const buffer = audioContext.createBuffer(1, data.data.length, 8000);
            const channelData = buffer.getChannelData(0);
            const rawData = new Float32Array(data.data);
            const len = Math.min(rawData.length, channelData.length);
            for (let i = 0; i < len; i++) {
              channelData[i] = rawData[i];
            }
            
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            source.start();
          }
        }
      } catch (e) {
        console.warn('صدا:', e);
      }
    };
    
    voiceWs.onclose = () => {
      if (isVoiceConnected) {
        isVoiceConnected = false;
        btn.textContent = '🎙️ اتصال صوتی';
        btn.classList.remove('active');
      }
    };
    
  } catch (err) {
    console.error('خطا:', err);
    alert('لطفاً دسترسی به میکروفون را اجازه دهید!');
  }
}

// ===== شروع =====

connectChat();
updateOnlineCount();
setInterval(updateOnlineCount, 15000);`;
}