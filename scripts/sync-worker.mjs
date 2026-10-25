// تزریق index.html به داخل index.js (ورکر کلادفلر) تا نسخه‌ی ورکر همیشه با فرانت‌اند یکی باشد
// اجرا: node scripts/sync-worker.mjs      (به‌صورت خودکار قبل از deploy و در test اجرا می‌شود)
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('index.html', 'utf8');
const src = readFileSync('index.js', 'utf8');
const re = /const htmlContent = ".*";/s;
if (!re.test(src)) { console.error('htmlContent در index.js پیدا نشد'); process.exit(1); }
const next = src.replace(re, () => 'const htmlContent = ' + JSON.stringify(html) + ';');
if (next !== src) { writeFileSync('index.js', next); console.log('index.js با index.html همگام شد'); }
else console.log('index.js از قبل همگام است');
