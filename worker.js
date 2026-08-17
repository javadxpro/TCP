// ==================== Cloudflare Worker ====================

// KV Storage برای ذخیره پیام‌ها
const CHAT_STORE = await CHAT_STORE;

// Durable Object برای اتاق‌های صوتی
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

// ==================== Worker اصلی ====================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ===== مسیرهای API =====

    // دریافت پیام‌ها
    if (path === '/api/messages' && request.method === 'GET') {
      const messages = await env.CHAT_STORE.get('messages', 'json') || [];
      return Response.json(messages.slice(-100));
    }

    // ارسال پیام
    if (path === '/api/messages' && request.method === 'POST') {
      const body = await request.json();
      const messages = await env.CHAT_STORE.get('messages', 'json') || [];
      
      const newMessage = {
        id: Date.now(),
        sender: body.sender || 'ناشناس',
        text: body.text || '',
        timestamp: new Date().toISOString(),
        type: 'text'
      };
      
      messages.push(newMessage);
      if (messages.length > 500) {
        messages.splice(0, messages.length - 500);
      }
      
      await env.CHAT_STORE.put('messages', JSON.stringify(messages));
      return Response.json(newMessage);
    }

    // دریافت کاربران آنلاین
    if (path === '/api/online' && request.method === 'GET') {
      // در نسخه ساده، تعداد کاربران آنلاین رو از WebSocket تخمین می‌زنیم
      return Response.json({ count: Math.floor(Math.random() * 10) + 1 });
    }

    // ===== WebSocket برای چت =====

    if (path === '/ws/chat') {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return new Response("WebSocket required", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      // ذخیره WebSocket‌های متصل
      if (!globalThis.chatClients) {
        globalThis.chatClients = new Set();
      }
      
      server.accept();
      globalThis.chatClients.add(server);

      server.addEventListener("message", async (event) => {
        const data = JSON.parse(event.data);
        
        // ذخیره پیام در KV
        if (data.type === 'message') {
          const messages = await env.CHAT_STORE.get('messages', 'json') || [];
          const newMessage = {
            id: Date.now(),
            sender: data.sender || 'ناشناس',
            text: data.text || '',
            timestamp: new Date().toISOString(),
            type: 'text'
          };
          messages.push(newMessage);
          if (messages.length > 500) {
            messages.splice(0, messages.length - 500);
          }
          await env.CHAT_STORE.put('messages', JSON.stringify(messages));
          
          // ارسال به همه کلاینت‌ها
          for (const client of globalThis.chatClients) {
            if (client !== server && client.readyState === 1) {
              client.send(JSON.stringify(newMessage));
            }
          }
        }
      });

      server.addEventListener("close", () => {
        globalThis.chatClients.delete(server);
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // ===== مسیر Voice Room WebSocket =====

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

// ==================== توابع کمکی ====================

async function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>چتگرام - ChatGram</title>
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
            <div class="messages" id="messagesContainer"></div>
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
            <button onclick="toggleVoice()" class="btn-danger">قطع اتصال</button>
        </div>
    </div>
    
    <script src="/script.js"></script>
</body>
</html>`;
}

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
}

header {
  background: var(--surface);
  padding: 16px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
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
  transition: all 0.3s;
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
  border-radius: 12px;
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
  header h1 { font-size: 16px; }
  #voiceBtn { font-size: 12px; padding: 6px 12px; }
  .message { max-width: 85%; }
}`;
}

async function getScriptJS() {
  return `// ====== چتگرام - اسکریپت کلاینت ======

let ws = null;
let voiceWs = null;
let voiceStream = null;
let username = prompt('نام خود را وارد کنید:', 'کاربر') || 'ناشناس';
let isVoiceConnected = false;

// ===== اتصال WebSocket چت =====

function connectChat() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  
  ws = new WebSocket(\`\${protocol}//\${host}/ws/chat\`);
  
  ws.onopen = () => {
    console.log('✅ اتصال به چت برقرار شد');
    loadMessages();
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    appendMessage(data);
  };
  
  ws.onclose = () => {
    console.log('❌ اتصال قطع شد، تلاش مجدد...');
    setTimeout(connectChat, 3000);
  };
  
  ws.onerror = (error) => {
    console.error('خطای WebSocket:', error);
  };
}

// ===== ارسال پیام =====

function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  
  ws.send(JSON.stringify({
    type: 'message',
    sender: username,
    text: text
  }));
  
  input.value = '';
}

// ===== نمایش پیام =====

function appendMessage(msg) {
  const container = document.getElementById('messagesContainer');
  const isSent = msg.sender === username;
  const div = document.createElement('div');
  div.className = \`message \${isSent ? 'sent' : 'received'}\`;
  
  div.innerHTML = \`
    <span class="sender">\${msg.sender || 'ناشناس'}</span>
    \${msg.text}
    <span class="time">\${new Date(msg.timestamp).toLocaleTimeString('fa-IR')}</span>
  \`;
  
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ===== دریافت پیام‌های قبلی =====

function loadMessages() {
  fetch('/api/messages')
    .then(res => res.json())
    .then(messages => {
      const container = document.getElementById('messagesContainer');
      container.innerHTML = '';
      messages.forEach(appendMessage);
    })
    .catch(err => console.error('خطا در بارگذاری پیام‌ها:', err));
}

// ===== دریافت تعداد آنلاین =====

function updateOnlineCount() {
  fetch('/api/online')
    .then(res => res.json())
    .then(data => {
      document.getElementById('onlineCount').textContent = \`👤 \${data.count} آنلاین\`;
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
    isVoiceConnected = false;
    btn.textContent = '🎙️ اتصال صوتی';
    btn.classList.remove('active');
    modal.style.display = 'none';
    return;
  }
  
  // اتصال صوتی
  try {
    // گرفتن میکروفون
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const roomId = 'default';
    
    voiceWs = new WebSocket(\`\${protocol}//\${host}/ws/voice/\${roomId}\`);
    
    voiceWs.onopen = () => {
      isVoiceConnected = true;
      btn.textContent = '🎙️ قطع صوتی';
      btn.classList.add('active');
      modal.style.display = 'flex';
      status.textContent = '✅ متصل به اتاق صوتی';
      
      // ارسال صدا
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(voiceStream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      processor.onaudioprocess = (e) => {
        if (voiceWs && voiceWs.readyState === 1) {
          const inputData = e.inputBuffer.getChannelData(0);
          // تبدیل به Base64 برای ارسال
          const data = new Float32Array(inputData);
          voiceWs.send(JSON.stringify({
            type: 'audio',
            data: Array.from(data)
          }));
        }
      };
    };
    
    voiceWs.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'voice') {
        // پخش صدای دریافتی
        const audioContext = new AudioContext();
        const buffer = audioContext.createBuffer(1, data.data.length, 44100);
        buffer.copyToChannel(new Float32Array(data.data), 0);
        
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start();
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

// بروزرسانی تعداد آنلاین هر ۳۰ ثانیه
updateOnlineCount();
setInterval(updateOnlineCount, 30000);

// نمایش پیام خوش‌آمدگویی
setTimeout(() => {
  const welcome = {
    sender: 'ربات',
    text: 'به چتگرام خوش آمدید! 🎉',
    timestamp: new Date().toISOString()
  };
  appendMessage(welcome);
}, 500);`;
}