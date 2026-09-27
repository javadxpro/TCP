#!/data/data/com.termux/files/usr/bin/bash
# راه‌اندازی و اجرای سرور سیگنالینگ در Termux
# استفاده:  bash termux-server.sh [PORT]
set -e
PORT="${1:-8080}"
command -v node >/dev/null 2>&1 || { echo "نصب Node.js..."; pkg update -y && pkg install -y nodejs; }
cd "$(dirname "$0")"
# جلوگیری از خوابیدن Termux وقتی صفحه خاموش است
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
# کپی خودکار آدرس در کلیپ‌بورد (نیازمند اپ Termux:API و پکیج termux-api)
IP=$(ip -4 addr 2>/dev/null | awk '/inet / && !/127.0.0.1/ {sub(/\/.*/,"",$2); print $2; exit}')
if [ -n "$IP" ] && command -v termux-clipboard-set >/dev/null 2>&1; then
  echo -n "$IP:$PORT" | termux-clipboard-set && echo "📋 آدرس $IP:$PORT در کلیپ‌بورد کپی شد؛ در تلگرام پیست کنید."
fi
while true; do
  PORT="$PORT" node server.js || true
  echo "سرور متوقف شد؛ ۳ ثانیه دیگر دوباره اجرا می‌شود (Ctrl+C دوبار برای خروج)..."
  sleep 3
done
