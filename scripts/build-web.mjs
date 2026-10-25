// کپی فایل‌های فرانت‌اند به پوشه www برای Capacitor
import { mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of ['index.html', 'manifest.json', 'icon.svg']) {
  if (existsSync(f)) copyFileSync(f, `www/${f}`);
}
console.log('www ready');
