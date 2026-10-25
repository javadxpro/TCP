#!/data/data/com.termux/files/usr/bin/bash
# راه‌اندازی و اجرای سرور سیگنالینگ در Termux
# استفاده:  bash termux-server.sh [PORT]      توقف: Ctrl+C
PORT="${1:-8080}"
command -v node >/dev/null 2>&1 || { echo "نصب Node.js..."; pkg update -y && pkg install -y nodejs; }
cd "$(dirname "$0")" || exit 1

STOP=0
trap 'STOP=1' INT TERM
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
PORT_FILE="${TMPDIR:-/tmp}/tcp-voice-port"

copy_addr() {
  local p ip
  p=$(cat "$PORT_FILE" 2>/dev/null || echo "$PORT")
  ip=$(ip -4 addr 2>/dev/null | awk '/inet / && !/127.0.0.1/ {sub(/\/.*/,"",$2); print $2; exit}')
  if [ -n "$ip" ] && command -v termux-clipboard-set >/dev/null 2>&1; then
    echo -n "$ip:$p" | termux-clipboard-set && echo "📋 آدرس $ip:$p در کلیپ‌بورد کپی شد."
  fi
}

while [ "$STOP" = 0 ]; do
  rm -f "$PORT_FILE"
  PORT="$PORT" PORT_FILE="$PORT_FILE" node server.js &
  NODE_PID=$!
  ( sleep 2; copy_addr ) &
  wait $NODE_PID
  CODE=$?
  [ "$STOP" = 1 ] && { kill $NODE_PID 2>/dev/null; wait $NODE_PID 2>/dev/null; break; }
  case $CODE in
    0) break ;;                       # خروج عادی
    2|3) exit $CODE ;;                # پورت اشغال / سرور از قبل روشن است ← تکرار نکن
  esac
  echo "سرور به‌طور غیرمنتظره متوقف شد (کد $CODE)؛ ۳ ثانیه دیگر دوباره اجرا می‌شود..."
  sleep 3
done
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
echo "خداحافظ 👋"
