// ==================== ChatGram - Cloudflare Worker ====================

// ===== WebSocket Clients =====
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
          // ارسال پیام صوتی به همه کلاینت‌های دیگر
          for (const client of this.clients) {
            if (client !== server && client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'voice',
                data: data
              }));
            }
          }
        } catch (e) {
          console.warn('خطا در پردازش پیام صوتی:', e);
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

    // ===== مسیرهای API =====

    // دریافت تعداد کاربران آنلاین (تخمینی)
    if (path === '/api/online' && request.method === 'GET') {
      const count = chatClients ? chatClients.size : 0;
      return Response.json({ count: count + 1 });
    }

    // ===== WebSocket برای چت =====

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
            for (const client of chatClients) {
              if (client.readyState === 1) {
                client.send(JSON.stringify(data));
              }
            }
            return;
          }
          
          // پیام معمولی
          if (data.type === 'message') {
            // ارسال به همه کلاینت‌ها
            for (const client of chatClients) {
              if (client !== server && client.readyState === 1) {
                client.send(JSON.stringify(data));
              }
            }
          }
        } catch (e) {
          console.warn('خطا در پردازش پیام:', e);
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

    // ===== WebSocket برای اتاق صوتی =====

    if (path.startsWith('/ws/voice/')) {
      const roomId = path.split('/')[3] || 'default';
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return new Response("WebSocket required", { status: 400 });
      }

      // استفاده از Durable Object برای هر اتاق
      const id = env.VOICE_ROOMS.idFromName(roomId);
      const obj = env.VOICE_ROOMS.get(id);
      return obj.fetch(request);
    }

    // ===== صفحات HTML/CSS/JS =====

    // صفحه اصلی
    if (path === '/' || path === '/index.html') {
      return new Response(await getIndexHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // فایل‌های استاتیک
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
    <title>💬 چتگرام - ChatGram</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <header>
        <h1>💬 چتگرام</h1>
        <div class="header-controls">
            <span id="onlineCount">👤 ۰ آنلاین</span>
            <button id="voiceBtn" onclick="toggleVoice()">🎙️ اتصال صوتی</button>
        </div>
    </header>
    
    <main>
        <div class="chat-container">
            <div class="messages" id="messagesContainer">
                <div class="message received">
                    <span class="sender">ربات</span>
                    👋 به چتگرام خوش آمدید! برای شروع گفتگو، پیام بنویسید.
                    <span class="time">همین الان</span>
                </div>
            </div>
            <div class="input-area">
                <input type="text" id="messageInput" placeholder="پیام بنویسید..." onkeypress="if(event.key==='Enter') sendMessage()">
                <button onclick="sendMessage()">📤</button>
            </div>
        </div>
    </main>
    
    <div class="voice-modal" id="voiceModal" style="display:none;">
        <div class="voice-container">
            <h3>🎙️ اتاق صوتی</h3>
            <div class="voice-status" id="voiceStatus">⏳ در حال اتصال...</div>
            <button onclick="toggleVoice()" class="btn-danger">🔴 قطع اتصال</button>
        </div>
    </div>
    
    <script src="/script.js"></script>
</body>
</html>`;
}

// ==================== CSS ====================

async function getStyleCSS() {
  return `/* ===== استایل چتگرام ===== */
:root {
  --primary: #5B4B8A;
  --primary-light: #7B6BAA;
  --bg: #0F0E1A;
  --surface: #1A1932;
  --surface-light: #2A2952;
  --text: #FFFFFF;
  --text-secondary: #A0A0C0;
  --border: rgba(255,255,255,0.1);
  --shadow: 0 8px 32px rgba(0,0,0,0.5);
  --radius: 12px;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

body {
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

header {
  background: var(--surface);
  padding: 16px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

header h1 {
  font-size: 20px;
  font-weight: 700;
  background: linear-gradient(135deg, #7B6BAA, #C084FC);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.header-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}

#onlineCount {
  font-size: 14px;
  color: var(--text-secondary);
}

#voiceBtn {
  background: var(--primary);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 20px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  transition: all 0.3s;
  white-space: nowrap;
}

#voiceBtn:hover {
  transform: scale(1.05);
  background: var(--primary-light);
}

#voiceBtn.active {
  background: #EF4444;
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
  background: var(--bg);
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.message {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: var(--radius);
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  animation: fadeIn 0.3s ease;
}

.message.sent {
  background: var(--primary);
  color: white;
  align-self: flex-end;
  border-bottom-right-radius: 4px;
}

.message.received {
  background: var(--surface);
  border: 1px solid var(--border);
  align-self: flex-start;
  border-bottom-left-radius: 4px;
}

.message .sender {
  font-size: 11px;
  font-weight: 700;
  color: var(--primary-light);
  margin-bottom: 4px;
  display: block;
}

.message.sent .sender {
  color: rgba(255,255,255,0.8);
}

.message .time {
  font-size: 10px;
  color: var(--text-secondary);
  margin-top: 4px;
  display: block;
  text-align: left;
}

.message.sent .time {
  color: rgba(255,255,255,0.6);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.input-area {
  padding: 16px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
}

.input-area input {
  flex: 1;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 24px;
  background: var(--bg);
  color: var(--text);
  outline: none;
  font-size: 14px;
  transition: all 0.3s;
}

.input-area input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(91, 75, 138, 0.3);
}

.input-area input::placeholder {
  color: var(--text-secondary);
}

.input-area button {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: var(--primary);
  color: white;
  font-size: 20px;
  cursor: pointer;
  transition: all 0.3s;
  flex-shrink: 0;
}

.input-area button:hover {
  transform: scale(1.05);
  background: var(--primary-light);
}

.voice-modal {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.8);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(8px);
}

.voice-container {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 32px;
  text-align: center;
  max-width: 400px;
  width: 90%;
  box-shadow: var(--shadow);
}

.voice-container h3 {
  font-size: 24px;
  margin-bottom: 16px;
}

.voice-status {
  font-size: 16px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.btn-danger {
  background: #EF4444;
  color: white;
  border: none;
  padding: 10px 24px;
  border-radius: 20px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  transition: all 0.3s;
}

.btn-danger:hover {
  transform: scale(1.05);
  background: #DC2626;
}

/* اسکرول‌بار */
::-webkit-scrollbar {
  width: 4px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}

/* موبایل */
@media (max-width: 768px) {
  header {
    padding: 12px 16px;
  }
  header h1 {
    font-size: 16px;
  }
  #voiceBtn {
    font-size: 12px;
    padding: 6px 12px;
  }
  .message {
    max-width: 85%;
    font-size: 13px;
    padding: 8px 12px;
  }
  .messages {
    padding: 12px;
  }
  .input-area {
    padding: 12px;
  }
  .input-area input {
    padding: 10px 14px;
    font-size: 13px;
  }
  .input-area button {
    width: 42px;
    height: 42px;
    font-size: 18px;
  }
}`;
}

// ==================== JavaScript ====================

async function getScriptJS() {
  return `// ====== چتگرام - اسکریپت کلاینت ======

let ws = null;
let voiceWs = null;
let voiceStream = null;
let username = prompt('نام خود را وارد کنید:', 'کاربر') || 'ناشناس';
let isVoiceConnected = false;
let reconnectAttempts = 0;
let audioContext = null;
let processor = null;

// ===== اتصال WebSocket چت =====

function connectChat() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  
  ws = new WebSocket(\`\${protocol}//\${host}/ws/chat\`);
  
  ws.onopen = () => {
    console.log('✅ اتصال به چت برقرار شد');
    reconnectAttempts = 0;
    // ارسال پیام خوش‌آمدگویی به همه
    sendWelcomeMessage();
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      appendMessage(data);
    } catch (e) {
      console.warn('خطا در解析 پیام:', e);
    }
  };
  
  ws.onclose = () => {
    console.log('❌ اتصال قطع شد، تلاش مجدد...');
    reconnectAttempts++;
    const delay = Math.min(3000 * reconnectAttempts, 30000);
    setTimeout(connectChat, delay);
  };
  
  ws.onerror = (error) => {
    console.error('خطای WebSocket:', error);
  };
}

// ===== ارسال پیام خوش‌آمدگویی =====

function sendWelcomeMessage() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'welcome',
      sender: 'ربات',
      text: \`👋 \${username} به چتگرام خوش آمدید!\`,
      timestamp: new Date().toISOString()
    }));
  }
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

// ===== دریافت تعداد آنلاین =====

function updateOnlineCount() {
  fetch('/api/online')
    .then(res => res.json())
    .then(data => {
      document.getElementById('onlineCount').textContent = \`👤 \${data.count || 0} آنلاین\`;
    })
    .catch(err => console.error('خطا:', err));
}

// ===== اتاق صوتی =====

async function toggleVoice() {
  const btn = document.getElementById('voiceBtn');
  const modal = document.getElementById('voiceModal');
  const status = document.getElementById('voiceStatus');
  
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
    modal.style.display = 'none';
    return;
  }
  
  // اتصال صوتی
  try {
    // گرفتن میکروفون
    voiceStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const roomId = 'default';
    
    voiceWs = new WebSocket(\`\${protocol}//\${host}/ws/voice/\${roomId}\`);
    
    voiceWs.onopen = () => {
      isVoiceConnected = true;
      btn.textContent = '🔴 قطع صوتی';
      btn.classList.add('active');
      modal.style.display = 'flex';
      status.textContent = '✅ متصل به اتاق صوتی';
      
      // راه‌اندازی پردازش صدا
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
          // نمونه‌برداری کاهش یافته
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
          // پخش صدای دریافتی
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
        console.warn('خطا در پخش صدا:', e);
      }
    };
    
    voiceWs.onclose = () => {
      if (isVoiceConnected) {
        isVoiceConnected = false;
        btn.textContent = '🎙️ اتصال صوتی';
        btn.classList.remove('active');
        modal.style.display = 'none';
        status.textContent = '❌ قطع شد';
      }
    };
    
  } catch (err) {
    console.error('خطا در اتصال صوتی:', err);
    status.textContent = '❌ خطا در دسترسی به میکروفون';
    alert('لطفاً دسترسی به میکروفون را اجازه دهید!');
  }
}

// ===== شروع برنامه =====

// اتصال به چت
connectChat();

// بروزرسانی تعداد آنلاین هر ۱۵ ثانیه
updateOnlineCount();
setInterval(updateOnlineCount, 15000);
`;
}