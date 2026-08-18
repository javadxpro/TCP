export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('ارتباط باید WebSocket باشد.', { status: 426 });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();

      // مدیریت پیام‌های دریافتی و ارسال همگانی (Broadcast)
      server.addEventListener('message', event => {
        try {
          const data = JSON.parse(event.data);
          // در سرور ساده سیگنال‌ها بازپخش می‌شوند
          server.send(JSON.stringify(data));
        } catch (e) {}
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  }
};