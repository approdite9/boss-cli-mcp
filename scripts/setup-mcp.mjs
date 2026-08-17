#!/usr/bin/env node
/**
 * 一条命令完成「配好 OCR + 打包本地代码 + 产出可直接粘贴的 MCP JSON」。
 *
 * 为什么密钥写到 `~/.boss-cli/.env` 而不是写进客户端 JSON 的 env 块：
 * - 客户端 JSON 会被复制到多个工具（Kiro / Qoder / Cursor …），密钥跟着复制 N 份，
 *   而这些配置文件经常躺在 git 仓库里。
 * - 用户级 .env 只有一份，`src/mcp/env.ts` 的候选路径里它优先级最高（仅次于显式 BOSS_MCP_ENV_FILE），
 *   所以任何客户端拉起 server 都能读到。
 * → 结论：JSON 里零密钥，每个客户端粘的内容完全一样。
 *
 * 为什么这个脚本不 import dist/：它要负责**触发**构建，不能依赖构建产物存在。
 * 因此 .env 合并逻辑在本文件内自带（与 `src/common/baidu_user_env.ts` 的语义保持一致：
 * 同名 key 先删旧行再追加）。OCR 状态检查放在构建之后，用动态 import 读 dist/。
 *
 * 用法：
 *   node scripts/setup-mcp.mjs                     # 构建 + 体检 + 打印 JSON（缺密钥时交互询问）
 *   node scripts/setup-mcp.mjs --no-input          # 全自动，不询问（CI / 只想拿 JSON）
 *   node scripts/setup-mcp.mjs --aliyun-id ID --aliyun-secret SECRET
 *   node scripts/setup-mcp.mjs --baidu-key KEY --baidu-secret SECRET
 *   node scripts/setup-mcp.mjs --disable-ocr       # 写入 BOSS_RESUME_OCR=0，明确关闭
 *   node scripts/setup-mcp.mjs --pack              # 额外 npm pack 出 tarball
 *   node scripts/setup-mcp.mjs --skip-build        # 跳过构建
 *
 * 多机部署（密钥只填一次，之后带着走）：
 *   node scripts/setup-mcp.mjs --export-env D:\u盘\boss-cli.env    # 在已配好的机器上导出
 *   node scripts/setup-mcp.mjs --import-env D:\u盘\boss-cli.env    # 在新机器上导入并继续完成配置
 *
 * 让 JSON 自带密钥（粘一份就能用，无需 .env）：
 *   node scripts/setup-mcp.mjs --embed-keys                        # 密钥内联进 JSON 的 env 块
 *   node scripts/setup-mcp.mjs --embed-keys --out D:\boss-mcp.json # 写到文件，不经终端回显
 *
 * 注意：用 --aliyun-* / --baidu-* 传密钥会留在 shell 历史里。默认的交互输入不回显、不入历史。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const APP_HOME = process.env.BOSS_APP_HOME?.trim() || join(homedir(), '.boss-cli');
const USER_ENV_PATH = join(APP_HOME, '.env');
const SERVER_ENTRY = join(REPO_ROOT, 'dist', 'mcp', 'server.js');

// ── 参数解析 ──────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      flags.add(key);
    }
  }
  return { opts, flags };
}

const { opts, flags } = parseArgs(process.argv.slice(2));
const interactive = !flags.has('no-input') && process.stdin.isTTY === true;

// ── ~/.boss-cli/.env 合并写入 ─────────────────────────────────
// 语义与 src/common/baidu_user_env.ts 的 mergeUserEnv 一致：同名 key 删旧行后追加。
function formatEnvLine(key, value) {
  if (/^[A-Za-z0-9_.\-]+$/.test(value)) return `${key}=${value}`;
  return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function mergeUserEnv(updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  if (!existsSync(APP_HOME)) mkdirSync(APP_HOME, { recursive: true });

  const drop = new Set(keys);
  let lines = [];
  if (existsSync(USER_ENV_PATH)) {
    lines = readFileSync(USER_ENV_PATH, 'utf8').split(/\r?\n/);
  }
  const kept = lines.filter((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    return !(m && drop.has(m[1]));
  });
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();

  const out = kept.length > 0 ? [...kept, ''] : [];
  for (const [k, v] of Object.entries(updates)) out.push(formatEnvLine(k, v));
  out.push('');
  writeFileSync(USER_ENV_PATH, out.join('\n'), 'utf8');
}

/** 读取用户级 .env 里已存在的 key（只返回 key 集合，不返回值） */
function existingUserEnvKeys() {
  if (!existsSync(USER_ENV_PATH)) return new Set();
  const set = new Set();
  for (const line of readFileSync(USER_ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

// ── 不回显的交互输入 ──────────────────────────────────────────
function askHidden(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') {
        process.stdin.removeListener('data', onData);
      } else {
        // 重绘为等长掩码，避免密钥出现在屏幕/滚动缓冲里
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        process.stdout.write(question + '*'.repeat(rl.line.length));
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      res(answer.trim());
    });
  });
}

function ask(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (a) => {
      rl.close();
      res(a.trim());
    });
  });
}

// ── 步骤 0：跨机器搬运配置 ───────────────────────────────────
// `~/.boss-cli/.env` 是明文、无机器绑定（不同于 Chrome 的 cookie 库——那个被 DPAPI /
// App-Bound Encryption 锁在「本机 + 本用户」上，拷过去解不开）。所以密钥可以只填一次、多机复用。

/** 导出整份用户级 .env 到指定路径，便于带到另一台机器。只列 key 名，不回显任何值。 */
function exportEnv(destRaw) {
  const dest = resolve(destRaw);
  if (!existsSync(USER_ENV_PATH)) {
    throw new Error(`没有可导出的配置：${USER_ENV_PATH} 不存在。先跑一次 npm run setup:mcp 填写密钥。`);
  }
  const content = readFileSync(USER_ENV_PATH, 'utf8');
  writeFileSync(dest, content, 'utf8');

  const keys = [...existingUserEnvKeys()];
  console.log(`✔ 已导出 ${keys.length} 个变量到 ${dest}`);
  console.log(`   包含: ${keys.join(', ')}`);
  console.log('');
  console.log('⚠ 这个文件里是**明文密钥**：');
  console.log('   · 不要提交到 git，不要放进任何会同步到公开仓库的目录');
  console.log('   · 传到新机器、导入完成后请删除');
  console.log('');
  console.log('新机器上执行：');
  console.log(`   node scripts/setup-mcp.mjs --import-env <这个文件的路径>`);
}

/** 从指定文件导入变量，合并进用户级 .env（同名 key 覆盖）。 */
function importEnv(srcRaw) {
  const src = resolve(srcRaw);
  if (!existsSync(src)) {
    throw new Error(`导入源文件不存在：${src}`);
  }
  const updates = {};
  for (const line of readFileSync(src, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!m) continue;
    let value = m[2].trim();
    // 还原 formatEnvLine 写出的带引号形式
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === 'string') value = parsed;
      } catch {
        /* 不是合法 JSON 字符串，按原样处理 */
      }
    }
    updates[m[1]] = value;
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    throw new Error(`${src} 里没有解析到任何 KEY=VALUE 行。`);
  }
  mergeUserEnv(updates);
  console.log(`✔ 已从 ${src} 导入 ${keys.length} 个变量 → ${USER_ENV_PATH}`);
  console.log(`   ${keys.join(', ')}`);
  console.log('   （导入完成后建议删除源文件，它是明文密钥）');
  console.log('');
}

// ── 步骤 1：OCR 密钥 ─────────────────────────────────────────
const ALIYUN_ID = 'BOSS_ALIYUN_ACCESS_KEY_ID';
const ALIYUN_SECRET = 'BOSS_ALIYUN_ACCESS_KEY_SECRET';
const BAIDU_KEY = 'BOSS_BAIDU_API_KEY';
const BAIDU_SECRET = 'BOSS_BAIDU_SECRET_KEY';

async function configureOcr() {
  const updates = {};

  if (flags.has('disable-ocr')) {
    updates.BOSS_RESUME_OCR = '0';
    mergeUserEnv(updates);
    console.log(`✔ 已写入 BOSS_RESUME_OCR=0（关闭 OCR，只截图不识别）→ ${USER_ENV_PATH}`);
    return;
  }

  const aliId = (opts['aliyun-id'] ?? '').trim();
  const aliSecret = (opts['aliyun-secret'] ?? '').trim();
  const baiduKey = (opts['baidu-key'] ?? '').trim();
  const baiduSecret = (opts['baidu-secret'] ?? '').trim();

  if (aliId || aliSecret) {
    if (!aliId || !aliSecret) throw new Error('--aliyun-id 与 --aliyun-secret 必须同时提供');
    updates[ALIYUN_ID] = aliId;
    updates[ALIYUN_SECRET] = aliSecret;
  }
  if (baiduKey || baiduSecret) {
    if (!baiduKey || !baiduSecret) throw new Error('--baidu-key 与 --baidu-secret 必须同时提供');
    updates[BAIDU_KEY] = baiduKey;
    updates[BAIDU_SECRET] = baiduSecret;
  }

  if (Object.keys(updates).length > 0) {
    mergeUserEnv(updates);
    console.log(`✔ OCR 凭证已写入 ${USER_ENV_PATH}`);
    return;
  }

  // 没通过参数给密钥：看已有配置，必要时交互询问
  const have = existingUserEnvKeys();
  const hasAliyun = have.has(ALIYUN_ID) && have.has(ALIYUN_SECRET);
  const hasBaidu = have.has(BAIDU_KEY) && have.has(BAIDU_SECRET);
  const disabled = have.has('BOSS_RESUME_OCR');

  if (hasAliyun || hasBaidu || disabled) {
    console.log(
      `✔ ${USER_ENV_PATH} 里已有 OCR 配置（${hasAliyun ? '阿里云' : ''}${hasAliyun && hasBaidu ? ' + ' : ''}${hasBaidu ? '百度' : ''}${disabled ? 'BOSS_RESUME_OCR 已显式设置' : ''}），跳过。`,
    );
    return;
  }

  if (!interactive) {
    console.log('⚠ 未检测到 OCR 配置，且当前非交互模式，跳过密钥设置。');
    return;
  }

  console.log('');
  console.log('未检测到 OCR 配置。在线简历需要 OCR 才能转成文字（阿里云优先，百度为备选）。');
  console.log('输入不回显、不写入 shell 历史。直接回车可跳过。');
  console.log('  1) 阿里云 OCR    2) 百度 OCR    3) 关闭 OCR（只截图）    回车=暂时跳过');
  const choice = await ask('选择 [1/2/3/回车]: ');

  if (choice === '1') {
    const id = await askHidden('  阿里云 AccessKeyId: ');
    const secret = await askHidden('  阿里云 AccessKeySecret: ');
    if (!id || !secret) {
      console.log('  两项都必须填写，已跳过。');
      return;
    }
    mergeUserEnv({ [ALIYUN_ID]: id, [ALIYUN_SECRET]: secret });
    console.log(`✔ 阿里云 OCR 凭证已写入 ${USER_ENV_PATH}`);
  } else if (choice === '2') {
    const key = await askHidden('  百度 API Key: ');
    const secret = await askHidden('  百度 Secret Key: ');
    if (!key || !secret) {
      console.log('  两项都必须填写，已跳过。');
      return;
    }
    mergeUserEnv({ [BAIDU_KEY]: key, [BAIDU_SECRET]: secret });
    console.log(`✔ 百度 OCR 凭证已写入 ${USER_ENV_PATH}`);
  } else if (choice === '3') {
    mergeUserEnv({ BOSS_RESUME_OCR: '0' });
    console.log(`✔ 已写入 BOSS_RESUME_OCR=0 → ${USER_ENV_PATH}`);
  } else {
    console.log('  已跳过。在线简历相关工具会被 preflight 拦下（不会白扣平台配额）。');
  }
}

// ── 步骤 2：构建 ─────────────────────────────────────────────
function runBuild() {
  if (flags.has('skip-build')) {
    console.log('· 跳过构建（--skip-build）');
    return;
  }
  console.log('· 构建中（tsc）…');
  // 直接用 node 跑本地 typescript 的入口：Windows 上 Node 20+ 拒绝无 shell 地 spawn `.cmd`，
  // 走 npx.cmd 会 EINVAL；而用 shell:true 又把命令行拼接引入进来。这样两边都躲开。
  const tscBin = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tscBin)) {
    throw new Error(`找不到 ${tscBin}\n请先在仓库根执行 npm install。`);
  }
  execFileSync(process.execPath, [tscBin], { cwd: REPO_ROOT, stdio: 'inherit' });
  console.log('✔ 构建完成');
}

/** tsc 不清理产物：src 里已删除的模块，dist 里可能残留旧 js 被误引用 */
function reportStaleDistDirs() {
  const pairs = [
    [join(REPO_ROOT, 'dist', 'mcp', 'oauth'), join(REPO_ROOT, 'src', 'mcp', 'oauth')],
  ];
  for (const [distDir, srcDir] of pairs) {
    if (existsSync(distDir) && !existsSync(srcDir)) {
      console.log(`⚠ dist 里残留已删除模块的产物：${distDir}`);
      console.log('   tsc 不会清理它。建议手动删除，避免旧代码被误引用。');
    }
  }
}

// ── 步骤 3：体检 ─────────────────────────────────────────────
async function healthCheck() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`构建产物缺失：${SERVER_ENTRY}\n请去掉 --skip-build 重跑。`);
  }

  const toUrl = (p) => new URL(`file://${p.replace(/\\/g, '/')}`).href;
  const { loadMcpEnv, formatEnvLoadReport } = await import(toUrl(join(REPO_ROOT, 'dist/mcp/env.js')));
  const report = loadMcpEnv(APP_HOME);

  const { isAliyunOcrConfigured } = await import(toUrl(join(REPO_ROOT, 'dist/ocr/aliyun_ocr.js')));
  const { isBaiduOcrConfigured } = await import(toUrl(join(REPO_ROOT, 'dist/ocr/baidu_ocr.js')));
  const { isResumeOcrEnabled, isOcrConfigured } = await import(
    toUrl(join(REPO_ROOT, 'dist/ocr/resume_ocr.js'))
  );
  const { inspectBrowserProfile } = await import(
    toUrl(join(REPO_ROOT, 'dist/mcp/local_guard.js'))
  );

  console.log('');
  console.log('── 体检 ──────────────────────────────────────');
  console.log(formatEnvLoadReport(report).replace(/^\[boss-mcp\] ?/gm, '  '));

  const enabled = isResumeOcrEnabled();
  const configured = isOcrConfigured();
  const backend = isAliyunOcrConfigured() ? '阿里云' : isBaiduOcrConfigured() ? '百度' : '无';
  console.log(`  OCR 开关     : ${enabled ? '开启' : '已关闭 (BOSS_RESUME_OCR)'}`);
  console.log(`  OCR 后端     : ${backend}`);
  if (enabled && !configured) {
    console.log('  ⚠ OCR 开启但无密钥：在线简历类工具会被 preflight 拦下（不消耗平台配额）');
  }

  const profile = inspectBrowserProfile();
  console.log(`  浏览器 profile: ${profile.dir}`);
  console.log(
    `                  ${profile.initialized ? '已初始化' : '尚未初始化'}${profile.hasCookieStore ? '，有 Cookie 库（不代表已登录）' : ''}`,
  );

  const headlessEnv = (process.env.BOSS_BROWSER_HEADLESS ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(headlessEnv)) {
    console.log('  ❌ BOSS_BROWSER_HEADLESS 为真 —— MCP server 会拒绝启动。请从环境/.env 中移除。');
  } else {
    console.log('  有头约束     : OK（未设置 BOSS_BROWSER_HEADLESS）');
  }

  return { enabled, configured, backend };
}

// ── 步骤 4：可选打包 ─────────────────────────────────────────
function runPack() {
  if (!flags.has('pack')) return null;
  console.log('');
  console.log('· npm pack…');
  // 参数全是字面量，没有外部输入拼接，故此处用 shell 是安全的（npm 在 Windows 上只有 .cmd 入口）
  const out = execFileSync('npm', ['pack'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: true,
  });
  const tarball = out.trim().split(/\r?\n/).pop();
  const abs = join(REPO_ROOT, tarball);
  console.log(`✔ 已打包：${abs}`);
  return abs;
}

// ── 步骤 5：产出可粘贴 JSON ──────────────────────────────────
/**
 * 可内联进客户端 JSON 的变量白名单。
 *
 * 刻意只放 OCR 凭证与 OCR 开关：
 * - `CHROME_PATH` / `BOSS_APP_HOME` 是**机器相关**的路径，跨机器复制只会带来错误路径。
 * - `BOSS_BROWSER_HEADLESS` 绝不内联——server 见到它为真会直接拒绝启动。
 * - 其余变量留在 `~/.boss-cli/.env`，按机器各自配置。
 */
const EMBEDDABLE_KEYS = [
  'BOSS_ALIYUN_ACCESS_KEY_ID',
  'BOSS_ALIYUN_ACCESS_KEY_SECRET',
  'BOSS_ALIYUN_OCR_ENDPOINT',
  'BOSS_BAIDU_API_KEY',
  'BOSS_BAIDU_SECRET_KEY',
  'BOSS_RESUME_OCR',
];

function collectEmbeddableEnv() {
  const env = {};
  for (const key of EMBEDDABLE_KEYS) {
    const v = process.env[key]?.trim();
    if (v) env[key] = v;
  }
  return env;
}

function printJson(tarball, options = {}) {
  const embedKeys = options.embedKeys === true;
  const outPath = options.outPath;

  // JSON 里用正斜杠：Node 在 Windows 下同样接受，且免去 \\ 转义带来的复制错误
  const entry = SERVER_ENTRY.replace(/\\/g, '/');

  const boss = {
    command: 'node',
    args: [entry],
    disabled: false,
    autoApprove: [],
  };

  let embedded = {};
  if (embedKeys) {
    embedded = collectEmbeddableEnv();
    if (Object.keys(embedded).length === 0) {
      console.log('');
      console.log('⚠ --embed-keys 没有可内联的变量：当前没有检测到任何 OCR 凭证。');
      console.log('  先跑一次 npm run setup:mcp 填写密钥，或用 --import-env 导入。');
    } else {
      // env 放在 command/args 之后、便于阅读；客户端传入的 env 优先级高于 ~/.boss-cli/.env
      boss.env = embedded;
    }
  }

  const config = { mcpServers: { boss } };
  const json = JSON.stringify(config, null, 2);

  if (outPath) {
    const dest = resolve(outPath);
    writeFileSync(dest, `${json}\n`, 'utf8');
    console.log('');
    console.log('── 客户端配置已写入文件 ──────────────────────');
    console.log(`  ${dest}`);
    if (Object.keys(embedded).length > 0) {
      console.log(`  已内联 ${Object.keys(embedded).length} 个变量：${Object.keys(embedded).join(', ')}`);
      console.log('  ⚠ 该文件含明文密钥，勿提交到 git；用完请删除。');
    }
  } else {
    console.log('');
    console.log('── 粘贴到 MCP 客户端配置 ─────────────────────');
    console.log('（Kiro: .kiro/settings/mcp.json；Qoder / Cursor / Claude Desktop 同为这套 mcpServers 结构）');
    if (Object.keys(embedded).length > 0) {
      console.log('⚠ 下面这段含**明文密钥**，注意别截图外发、别提交到 git。');
    }
    console.log('');
    console.log(json);
  }

  console.log('');
  console.log('若客户端里已有其它 server，只把 "boss" 这一项合并进现有的 mcpServers 对象即可。');
  console.log('');
  console.log('要点：');
  console.log('  · 用 command:"node" + 绝对路径，绕开 Windows 上 npm 全局 bin 的 .cmd/.ps1 shim 问题');
  if (Object.keys(embedded).length > 0) {
    console.log('  · 密钥已内联：目标机器无需 ~/.boss-cli/.env，粘这一份即可用');
    console.log('  · 客户端 env 的优先级高于 ~/.boss-cli/.env（进程启动时就在环境里，dotenv 不覆盖已有值）');
    console.log('  · 代价：密钥会散落在每个客户端配置里。轮换密钥时需要逐个更新；');
    console.log('    且这类文件常在工作区内（如 .kiro/settings/mcp.json），务必确认它没被 git 跟踪');
  } else {
    console.log('  · JSON 里不含密钥 —— OCR 凭证只在 ~/.boss-cli/.env 一份');
    console.log('  · 想让 JSON 自带密钥（换机器粘一份就能用）：加 --embed-keys');
  }
  console.log('  · 不要在 env 里加 BOSS_BROWSER_HEADLESS，server 会拒绝启动');
  console.log('  · 同一时间只让一个客户端连接：多个实例会争同一把会话锁（30s 后报 session is busy）');

  if (tarball) {
    console.log('');
    console.log('── 换机器部署（用 tarball） ───────────────────');
    console.log(`  npm i -g "${tarball.replace(/\\/g, '/')}"`);
    console.log('  装完后 JSON 可简化为 { "command": "boss-mcp" }，');
    console.log('  但 Windows 上部分客户端无法直接 spawn npm shim，遇到问题就回到 node + 绝对路径。');
  }
}

// ── main ─────────────────────────────────────────────────────
try {
  console.log('boss-cli MCP 一键配置');
  console.log(`仓库: ${REPO_ROOT}`);
  console.log('');

  // 纯导出：不需要构建，也不需要打印 JSON，做完即退出
  const exportTo = (opts['export-env'] ?? '').trim();
  if (exportTo) {
    exportEnv(exportTo);
    process.exit(0);
  }

  // 导入后继续走完整流程（新机器上正是需要 构建 + 体检 + JSON 的场景）
  const importFrom = (opts['import-env'] ?? '').trim();
  if (importFrom) {
    importEnv(importFrom);
  }

  await configureOcr();
  runBuild();
  reportStaleDistDirs();
  const status = await healthCheck();
  const tarball = runPack();
  printJson(tarball, {
    embedKeys: flags.has('embed-keys'),
    outPath: (opts.out ?? '').trim() || undefined,
  });

  console.log('');
  console.log('── 下一步 ────────────────────────────────────');
  console.log('  1) 粘贴上面的 JSON 到客户端配置并重启客户端');
  console.log('  2) 终端执行 `boss login`，用 App 扫码（登录只能人工在有头浏览器完成）');
  console.log('  3) 在客户端里先调只读工具验证：boss_list_positions / boss_list_candidates');
  if (status.enabled && !status.configured) {
    console.log('  4) 想用在线简历，补上 OCR 密钥：node scripts/setup-mcp.mjs');
  }
} catch (e) {
  console.error('');
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
