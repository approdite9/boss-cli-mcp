#!/usr/bin/env node
/**
 * 单独验证阿里云 OCR，把它从「打开简历 → 截图 → OCR」整条链路里隔离出来。
 *
 * 为什么需要：走正常流程排查 OCR 会**先消耗一次每日简历查看配额**，
 * 而且失败原因会混在浏览器、页面、配额等一堆因素里。这个脚本只发一次 OCR 请求。
 *
 * 用法：
 *   node scripts/test-aliyun-ocr.mjs                    # 自动取 ~/.boss-cli/.cache/resume-screenshots 里最新一张
 *   node scripts/test-aliyun-ocr.mjs D:\some\image.png  # 指定图片
 *
 * 需要先 npm run build（本脚本读 dist/），并已在 ~/.boss-cli/.env 配好密钥。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_HOME = process.env.BOSS_APP_HOME?.trim() || join(homedir(), '.boss-cli');
const REPO_ROOT = resolve(import.meta.dirname, '..');

// ── 加载 .env（与 src/mcp/env.ts 的优先级一致） ───────────────
for (const p of [join(APP_HOME, '.env'), join(REPO_ROOT, '.env')]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  console.log(`已加载 .env：${p}`);
}

// ── 凭证体检（不回显密钥本身） ────────────────────────────────
const id = process.env.BOSS_ALIYUN_ACCESS_KEY_ID ?? process.env.ALIYUN_ACCESS_KEY_ID ?? '';
const secret = process.env.BOSS_ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIYUN_ACCESS_KEY_SECRET ?? '';

function inspect(name, raw) {
  if (!raw) return `${name}: <未设置>`;
  const trimmed = raw.trim();
  const flags = [];
  // 这几种「看不见的脏字符」是 SignatureDoesNotMatch 最常见的来源
  if (trimmed !== raw) flags.push('⚠️首尾有空白');
  if (/["']/.test(raw)) flags.push('⚠️含引号');
  if (/[^\x20-\x7E]/.test(raw)) flags.push('⚠️含非 ASCII（可能是中文输入法的全角字符）');
  return `${name}: 长度=${raw.length} 头尾=${trimmed.slice(0, 3)}…${trimmed.slice(-3)} ${flags.join(' ') || 'OK'}`;
}

console.log('');
console.log('── 凭证 ──────────────────────────────────────');
console.log(' ', inspect('AccessKeyId', id));
console.log(' ', inspect('AccessKeySecret', secret));
console.log('  Endpoint:', process.env.BOSS_ALIYUN_OCR_ENDPOINT?.trim() || 'ocr-api.cn-hangzhou.aliyuncs.com（默认）');

if (!id || !secret) {
  console.error('\n❌ 缺少凭证，无法继续。请在 ~/.boss-cli/.env 设置 BOSS_ALIYUN_ACCESS_KEY_ID / BOSS_ALIYUN_ACCESS_KEY_SECRET。');
  process.exit(1);
}

// ── 时钟检查 ──────────────────────────────────────────────────
// 阿里云 V3 签名对时间敏感：本机时间与服务端相差过大会直接判签名失败。
// 虚拟机在宿主挂起/恢复后很容易漂。
console.log('');
console.log('── 时钟 ──────────────────────────────────────');
console.log('  本机 UTC:', new Date().toISOString());
try {
  const r = await fetch('https://ocr-api.cn-hangzhou.aliyuncs.com/', { method: 'HEAD' });
  const serverDate = r.headers.get('date');
  if (serverDate) {
    const skewMs = Date.now() - new Date(serverDate).getTime();
    const skewSec = Math.round(skewMs / 1000);
    console.log('  阿里云:  ', new Date(serverDate).toISOString());
    console.log(
      `  偏差:    ${skewSec}s`,
      Math.abs(skewSec) > 300 ? '⚠️ 超过 5 分钟，签名会被拒绝，请先校准系统时间（w32tm /resync）' : 'OK',
    );
  }
} catch (e) {
  console.log('  无法获取服务端时间：', e instanceof Error ? e.message : String(e));
}

// ── 选图 ──────────────────────────────────────────────────────
function latestScreenshot() {
  const dir = join(APP_HOME, '.cache', 'resume-screenshots');
  if (!existsSync(dir)) return undefined;
  const pngs = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return pngs[0];
}

const imagePath = process.argv[2] ? resolve(process.argv[2]) : latestScreenshot();
if (!imagePath || !existsSync(imagePath)) {
  console.error(
    [
      '',
      '❌ 没有可用于测试的图片。',
      `  已找过：${join(APP_HOME, '.cache', 'resume-screenshots')}`,
      '  请显式指定一张含文字的 PNG/JPG：node scripts/test-aliyun-ocr.mjs <路径>',
    ].join('\n'),
  );
  process.exit(1);
}

// ── 调用 ──────────────────────────────────────────────────────
const modPath = join(REPO_ROOT, 'dist', 'ocr', 'aliyun_ocr.js');
if (!existsSync(modPath)) {
  console.error(`\n❌ 未找到 ${modPath}，请先执行 npm run build。`);
  process.exit(1);
}
const { aliyunOcrImageBuffer } = await import(pathToFileURL(modPath).href);

console.log('');
console.log('── 调用 ──────────────────────────────────────');
console.log('  图片:', imagePath);
const buf = readFileSync(imagePath);
console.log(`  大小: ${(buf.length / 1024).toFixed(1)} KB`);

const t0 = Date.now();
try {
  const text = await aliyunOcrImageBuffer(buf);
  console.log(`\n✅ 成功，耗时 ${Date.now() - t0}ms，识别 ${text.length} 字符`);
  console.log('\n── 前 300 字 ──');
  console.log(text.slice(0, 300));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`\n❌ 失败，耗时 ${Date.now() - t0}ms`);
  console.error('  ', msg);
  console.error('');
  console.error('── 按错误码对症 ──────────────────────────────');
  console.error('  SignatureDoesNotMatch      → Secret 不对，或系统时间偏差过大（见上方时钟检查），或密钥里混入了空白/引号/全角字符');
  console.error('  InvalidAccessKeyId.NotFound→ AccessKeyId 不存在或已删除');
  console.error('  Forbidden.RAMUserAccessDenied / NoPermission');
  console.error('                             → RAM 用户缺少 OCR 权限，需授予 AliyunOCRFullAccess 之类的策略');
  console.error('  Forbidden.Arrears / *Arrears*');
  console.error('                             → 账号欠费或免费额度已用尽（OCR 是计费服务，这是「之前能用、突然不行」最常见的原因）');
  console.error('  Throttling*                → 触发 QPS 限流，稍后重试');
  console.error('');
  console.error('  注意：即便配了百度密钥，阿里云失败时也**不会**自动切百度——');
  console.error('  项目规则禁止 fallback（AGENTS.md）。要用百度就得移除阿里云的两个环境变量。');
  process.exit(1);
}
