// تزریق index.html و signal.js به داخل index.js (ورکر کلادفلر) تا نسخه‌ی ورکر همیشه با فرانت‌اند یکی باشد
// اجرا: node scripts/sync-worker.mjs      (به‌صورت خودکار قبل از deploy و در test اجرا می‌شود)
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('index.html', 'utf8');
const sig = readFileSync('signal.js', 'utf8');
let src = readFileSync('index.js', 'utf8');
// یک رشته‌ی JSON تک‌خطی: "..." بدون newline، با escape‌ها
const STR = '"(?:[^"\\\\\\n]|\\\\.)*"';
const inject = (name, value) => {
  const re = new RegExp('const ' + name + ' = ' + STR + ';');
  if (!re.test(src)) { console.error(name + ' در index.js پیدا نشد'); process.exit(1); }
  src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify(value) + ';');
};
inject('htmlContent', html);
inject('signalJs', sig);
if (src !== readFileSync('index.js', 'utf8')) { writeFileSync('index.js', src); console.log('index.js با index.html و signal.js همگام شد'); }
else console.log('index.js از قبل همگام است');
