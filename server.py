# server.py - روی گوشی اجرا میشه

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
import socket
import json

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

clients = set()

@app.route('/api/status')
def status():
    return jsonify({
        'status': 'online',
        'clients': len(clients),
        'ip': socket.gethostbyname(socket.gethostname())
    })

@app.route('/api/message', methods=['POST'])
def message():
    data = request.json
    # پردازش پیام
    socketio.emit('message', data)
    return jsonify({'success': True})

@socketio.on('connect')
def handle_connect():
    clients.add(request.sid)
    print(f'✅ کلاینت متصل شد: {request.sid}')

@socketio.on('disconnect')
def handle_disconnect():
    clients.discard(request.sid)
    print(f'❌ کلاینت قطع شد: {request.sid}')

@socketio.on('message')
def handle_message(data):
    print(f'📩 پیام: {data}')
    emit('message', data, broadcast=True)

if __name__ == '__main__':
    # پیدا کردن آی‌پی
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('8.8.8.8', 80))
    ip = s.getsockname()[0]
    s.close()
    
    print(f'🚀 سرور روی آی‌پی: {ip}:5000')
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)