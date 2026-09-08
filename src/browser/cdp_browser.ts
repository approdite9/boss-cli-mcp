import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { BROWSER_USER_DATA_DIR, ensureAppDataLayout } from '../config.js';
import { captureIncident } from '../common/incident.js';

/** 与 @puppeteer/browsers 一致，解析 Chrome 启动日志中的 CDP WebSocket URL（可能在 stdout 或 stderr）。 */
const CDP_WEBSOCKET_ENDPOINT_REGEX = /^DevTools listening on (ws:\/\/.*)$/;

const LAUNCH_READY_MS = 30_000;

/**
 * 单条 CDP 命令的等待上限（puppeteer 默认 180s）。
 *
 * 为什么必须调小：现场遇到过 Chrome 长时间无响应（约 55 分钟后自行恢复）。默认 180s 下，
 * 每个工具调用都要卡满 3 分钟才吐一句 `Page.addScriptToEvaluateOnNewDocument timed out`，
 * 而 Agent 会持续重试——审计日志里 18 次失败、连带排队叠加到单次 364s，一小时全耗在等待上。
 * 收到 60s 后同样的情况一轮只损失 1 分钟，且 MCP 单次调用看门狗（默认 240s）还能兜住。
 *
 * 不能设得更小：长简历整框截图本身就是一条慢 CDP 命令，几十秒是正常的。
 * 可用 `BOSS_BROWSER_PROTOCOL_TIMEOUT_MS` 覆盖。
 */
const PROTOCOL_TIMEOUT_MS: number = (() => {
  const raw = process.env.BOSS_BROWSER_PROTOCOL_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60_000;
})();

/** 复用已有实例前的 CDP 存活校验超时。一次 `Browser.getVersion` 往返，健康时是毫秒级。 */
const CDP_LIVENESS_TIMEOUT_MS = 5_000;

/**
 * 固定的远程调试端口：boss-cli 使用独立的 user-data-dir，因此可以稳定占用一个端口，
 * 让多个命令直接通过 `http://127.0.0.1:<port>/json/version` 复用同一只浏览器。
 * 可用 `BOSS_BROWSER_REMOTE_DEBUGGING_PORT` 覆盖。
 */
export const REMOTE_DEBUGGING_PORT: number = (() => {
  const raw = process.env.BOSS_BROWSER_REMOTE_DEBUGGING_PORT?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  return 53470;
})();

let spawnedChromeChild: ChildProcess | null = null;
/** 最近一次 `connectBrowser` 是否以无头方式启动（`browser.process()` 在 connect 模式下不可用，供 login 等逻辑判断）。 */
let lastChromeLaunchHeadless = false;

export function clearSpawnedChromeProcessRef(): void {
  spawnedChromeChild = null;
}

/** 最近一次启动是否为无头（仅本进程内、与当前会话一致时有效）。 */
export function wasLastChromeLaunchHeadless(): boolean {
  return lastChromeLaunchHeadless;
}

/**
 * 探测固定调试端口上是否已有在跑的 Chrome：直接命中 `/json/version` 拿当前
 * `webSocketDebuggerUrl`，避免依赖 `DevToolsActivePort` 这种二级状态文件
 * （可能被陈旧/清理/路径 UUID 漂移影响）。命中即可复用，未命中表示需要 spawn。
 */
async function probeRemoteDebuggingWsEndpoint(
  port: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    const ws = data.webSocketDebuggerUrl;
    return typeof ws === 'string' && ws.length > 0 ? ws : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 校验刚连上的浏览器**真的能处理 CDP 命令**，不只是端口通。
 *
 * 为什么 `/json/version` 不够：那个 HTTP 端点由浏览器进程的独立线程伺服，
 * 主线程/CDP 分发卡住时它照样返回 200。现场就出现过探活成功、`puppeteer.connect` 成功、
 * `browser.connected === true`，但第一条真实命令（注入页面守卫的
 * `Page.addScriptToEvaluateOnNewDocument`）挂满超时的情况——错误信息完全指不到根因。
 *
 * 这里发一条最便宜的 `Browser.getVersion`（`browser.version()`）：健康时毫秒级返回。
 * 超时即断开连接并抛出可操作的错误，**不杀浏览器**——现场证据显示它会自行恢复，
 * 杀掉反而会丢掉登录态、逼用户重新扫码。
 */
async function assertCdpResponsive(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('CDP_LIVENESS_TIMEOUT'));
    }, CDP_LIVENESS_TIMEOUT_MS);
  });

  try {
    await Promise.race([browser.version(), timeout]);
  } catch (e) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyB = browser as any;
      if (typeof anyB.disconnect === 'function') {
        await Promise.resolve(anyB.disconnect());
      }
    } catch {
      /* 连接本就不可用，断开失败可忽略 */
    }
    const raw = e instanceof Error ? e.message : String(e);
    const reason = raw === 'CDP_LIVENESS_TIMEOUT' ? `${CDP_LIVENESS_TIMEOUT_MS}ms 内无响应` : raw;
    // 浏览器整体不响应 CDP 是另一种签名（不是单个渲染进程僵死），同样只有此刻能取证。
    void captureIncident('cdp-unresponsive', `调试端口 ${REMOTE_DEBUGGING_PORT} 上的浏览器无法处理 CDP 命令（${reason}）。`);
    throw new Error(
      [
        `调试端口 ${REMOTE_DEBUGGING_PORT} 上的浏览器无法处理 CDP 命令（${reason}）。`,
        '端口能连上但命令不响应，通常是浏览器进程被内存压力/换页拖住（现场记录过持续约 55 分钟后自行恢复）。',
        '本次调用已提前中止，未消耗任何配额；请稍后重试，或到该机器上确认 Chrome 与内存状态。',
        '不要因为这个错误去调用登录类工具——它与登录态无关。',
      ].join('\n'),
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function waitForDevToolsWebSocketUrl(
  proc: ChildProcess,
  userDataDir: string,
  timeoutMs: number,
): Promise<string> {
  const streams = [proc.stdout, proc.stderr].filter((s): s is NonNullable<typeof s> => s != null);
  if (streams.length === 0) {
    return Promise.reject(new Error('浏览器子进程无 stdout/stderr，无法获取 CDP 地址'));
  }

  return new Promise((resolve, reject) => {
    const rls: readline.Interface[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      for (const rl of rls) {
        try {
          rl.close();
        } catch {
          /* ignore */
        }
      }
      rls.length = 0;
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      proc.off('exit', onExit);
      proc.off('error', onProcError);
      cleanup();
      fn();
    };

    timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`等待 Chrome 输出 DevTools 地址超时（${timeoutMs}ms）`));
      });
    }, timeoutMs);

    const onExit = (code: number | null) => {
      finish(() => {
        reject(
          new Error(
            code === 0
              ? `浏览器进程立即以代码 0 退出：user-data-dir「${userDataDir}」可能正被另一只「无远程调试端口」的 Chrome 持有（Chrome 单例锁会让我们 spawn 的新进程把命令行交还给它后立刻退出）。请关闭占用该目录的 Chrome 窗口后重试。`
              : `浏览器进程在就绪前退出（代码 ${code ?? 'unknown'}）`,
          ),
        );
      });
    };

    const onProcError = (err: Error) => {
      finish(() => {
        reject(err);
      });
    };

    const onLine = (line: string) => {
      const m = line.trim().match(CDP_WEBSOCKET_ENDPOINT_REGEX);
      if (m?.[1]) {
        finish(() => {
          resolve(m[1]);
        });
      }
    };

    proc.once('exit', onExit);
    proc.once('error', onProcError);

    for (const s of streams) {
      const rl = readline.createInterface(s);
      rls.push(rl);
      rl.on('line', onLine);
    }
  });
}

/** 在未配置路径时，尝试常见安装位置（Chrome / Edge / Chromium）。 */
function findLocalChromiumExecutable(): string | undefined {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const pf = process.env.PROGRAMFILES;
    const pf86 = process.env['PROGRAMFILES(X86)'];
    if (local) {
      candidates.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (pf) {
      candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (pf86) {
      candidates.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// CloakBrowser 集成层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 检测是否启用 CloakBrowser 引擎。
 * 环境变量：BOSS_BROWSER_ENGINE=cloakbrowser（大小写不敏感）
 * 或设置 CLOAKBROWSER_BINARY_PATH 即视为启用。
 */
function isCloakBrowserEnabled(): boolean {
  const engine = process.env.BOSS_BROWSER_ENGINE?.trim().toLowerCase();
  if (engine === 'cloakbrowser' || engine === 'cloak') return true;
  if (process.env.CLOAKBROWSER_BINARY_PATH?.trim()) return true;
  return false;
}

/**
 * 查找 CloakBrowser 隐身 Chromium 二进制路径。
 * 优先级：
 * 1. CLOAKBROWSER_BINARY_PATH 环境变量（精确路径）
 * 2. ~/.cloakbrowser/ 缓存目录下自动探测
 */
function findCloakBrowserExecutable(): string | undefined {
  // 1. 显式设置的路径
  const explicit = process.env.CLOAKBROWSER_BINARY_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // 2. 自动探测 ~/.cloakbrowser/ 下载缓存
  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR?.trim()
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cloakbrowser');

  if (!existsSync(cacheDir)) return undefined;

  try {
    const entries = readdirSync(cacheDir, { withFileTypes: true });
    // 查找形如 chromium-xxx/ 或 chrome-xxx/ 的子目录
    const chromeDirs = entries
      .filter(e => e.isDirectory() && /^(chromium|chrome)/i.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse(); // 取最新版本

    for (const dir of chromeDirs) {
      const candidates = process.platform === 'win32'
        ? [
            path.join(cacheDir, dir, 'chrome.exe'),
            path.join(cacheDir, dir, 'chromium.exe'),
          ]
        : process.platform === 'darwin'
          ? [
              path.join(cacheDir, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
              path.join(cacheDir, dir, 'chrome'),
            ]
          : [
              path.join(cacheDir, dir, 'chrome'),
              path.join(cacheDir, dir, 'chromium'),
            ];

      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  } catch {
    /* ignore fs errors */
  }

  return undefined;
}

/**
 * 生成 CloakBrowser 隐身启动参数。
 * 模拟 getDefaultStealthArgs() 的行为，并针对 Boss 直聘场景增强。
 */
function getCloakBrowserStealthArgs(): string[] {
  // 生成随机指纹种子（每次启动不同身份）
  // 如果设置了 CLOAKBROWSER_FINGERPRINT_SEED 则用固定值（保持身份一致性）
  const seedEnv = process.env.CLOAKBROWSER_FINGERPRINT_SEED?.trim();
  const seed = seedEnv && /^\d+$/.test(seedEnv)
    ? seedEnv
    : String(crypto.randomInt(10000, 99999));

  const isMac = process.platform === 'darwin';
  const platform = isMac ? 'macos' : 'windows';

  const args: string[] = [
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${platform}`,
    // GPU 相关 — 让 WebGL fingerprint 与声称的平台一致
    '--ignore-gpu-blocklist',
    // Linux 无桌面环境需要 disable-gpu 防止渲染崩溃
    ...(process.platform === 'linux' ? ['--disable-gpu', '--disable-software-rasterizer'] : []),
    // WebRTC IP 伪造 — 自动匹配代理出口 IP
    '--fingerprint-webrtc-ip=auto',
    // 硬件参数 — 模拟典型办公设备
    '--fingerprint-hardware-concurrency=8',
    '--fingerprint-device-memory=8',
    // 屏幕 — 典型 1920x1080 显示器
    '--fingerprint-screen-width=1920',
    '--fingerprint-screen-height=1080',
    // 启用渲染噪声注入（Canvas/WebGL 指纹扰动）
    '--fingerprint-noise',
    // 允许第三方 Cookie（Boss 登录态依赖）
    '--fingerprint-allow-3p-cookies',
  ];

  // 时区 & 语言 — Boss 直聘中国场景
  const tz = process.env.CLOAKBROWSER_TIMEZONE?.trim() || 'Asia/Shanghai';
  const locale = process.env.CLOAKBROWSER_LOCALE?.trim() || 'zh-CN';
  args.push(`--fingerprint-timezone=${tz}`);
  args.push(`--fingerprint-locale=${locale}`);

  return args;
}

/** 减轻「正受到自动测试软件的控制」提示与常见自动化特征（非万能，站点仍可能用其它方式检测）。手动开 Chrome 并接 CDP 时可复用。 */
export const LAUNCH_ARGS_LESS_AUTOMATION = [
  '--disable-infobars',
  '--deny-permission-prompts',
  '--disable-notifications',
] as const;

/**
 * 额外的 Chrome 启动参数，空格分隔，来自 `BOSS_BROWSER_EXTRA_ARGS`。
 *
 * 存在的理由：诊断能力（崩溃日志、verbose 日志）需要能临时开关，而不是改代码再发一次。
 * 现场遇到的问题就属于这一类——渲染进程僵死时既没有崩溃转储也没有 Chrome 日志，
 * 只能靠猜；有了这个入口，下次出问题前就能把取证打开，出问题后再关掉。
 *
 * 刻意不支持带空格的参数值：那需要引号解析，而目前所有诊断参数（`--log-file=` 的路径、
 * `--vmodule=` 的模式表）都不含空格。写错的条目直接抛错，不静默丢弃——
 * 否则会出现「以为诊断开着、其实参数被吃了」这种最坏情况。
 */
function readExtraChromeArgs(): string[] {
  const raw = process.env.BOSS_BROWSER_EXTRA_ARGS?.trim();
  if (!raw) return [];
  const parts = raw.split(/\s+/).filter(Boolean);
  const bad = parts.filter((p) => !p.startsWith('--'));
  if (bad.length > 0) {
    throw new Error(
      `BOSS_BROWSER_EXTRA_ARGS 里有不以 -- 开头的条目：${bad.join(' ')}。` +
        `该变量按空格分隔，不支持带空格的参数值。`,
    );
  }
  return parts;
}

/** 仅用于本地调试：尽量放宽同源/CORS 限制，便于跨域 iframe/canvas 处理。 */
export const LAUNCH_ARGS_ALLOW_ALL_CORS = [
  '--disable-web-security',
  '--allow-running-insecure-content',
] as const;

export type ConnectBrowserOptions = {
  /** 用于启动本机 Chrome/Edge */
  executablePath?: string;
  /** 启动浏览器时复用的用户数据目录（登录态/缓存等） */
  userDataDir?: string;
  /** 启动浏览器时指定 profile（如 `Default` / `Profile 1`） */
  profileDirectory?: string;
  /** 默认 `false`（有界面）。也可用环境变量 `BOSS_BROWSER_HEADLESS=true` 开无头。 */
  headless?: boolean;
  /** 仅本地调试用：放宽同源/CORS 策略（高风险，默认关闭）。 */
  allowAllCors?: boolean;
}

/**
 * 启动本机浏览器（puppeteer-core 底层为 Chrome DevTools Protocol）。
 *
 * 环境变量（可选）：
 * - `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` — 启动本机浏览器可执行文件路径（高于自动探测）
 * - `BOSS_BROWSER_USER_DATA_DIR` — 启动浏览器时复用的用户数据目录；未设置时默认 `~/.boss-cli/.cache/browser-data`
 * - `BOSS_BROWSER_PROFILE_DIRECTORY` — 启动浏览器时指定 profile（如 `Default`）
 * - `BOSS_BROWSER_REMOTE_DEBUGGING_PORT` — 远程调试端口（默认 53470）；同一 user-data-dir 跨命令复用该端口
 * - `BOSS_BROWSER_ALLOW_ALL_CORS` — 设为 `true` 时附加放宽同源/CORS 的启动参数（仅调试）
 * - `BOSS_BROWSER_DISABLE_GPU` — 设为 `true` 时附加 `--disable-gpu`
 *
 * 若以上均未设置，会按系统尝试常见 Chrome / Edge / Chromium 安装路径。
 * - `BOSS_BROWSER_HEADLESS` — 设为 `true` 时启用无头；默认**有界面**。
 * - `BOSS_BROWSER_VIEWPORT_WIDTH` / `BOSS_BROWSER_VIEWPORT_HEIGHT` — 启动时显式指定视口；未设置时不覆盖浏览器窗口尺寸
 */
/** 启动浏览器时的默认视口（与环境变量一致）；截图恢复时 `viewport()` 为 null 也可用其兜底。 */
export function defaultViewportFromEnv(): { width: number; height: number } {
  const w = Number.parseInt(process.env.BOSS_BROWSER_VIEWPORT_WIDTH?.trim() ?? '', 10);
  const h = Number.parseInt(process.env.BOSS_BROWSER_VIEWPORT_HEIGHT?.trim() ?? '', 10);
  return {
    width: Number.isFinite(w) && w > 0 ? w : 1280,
    height: Number.isFinite(h) && h > 0 ? h : 1200,
  };
}

/** 仅在显式配置了视口环境变量时返回启动视口；否则返回 null，不覆盖浏览器实际窗口尺寸。 */
function launchViewportFromEnv(): { width: number; height: number } | null {
  const rawW = process.env.BOSS_BROWSER_VIEWPORT_WIDTH?.trim() ?? '';
  const rawH = process.env.BOSS_BROWSER_VIEWPORT_HEIGHT?.trim() ?? '';
  if (!rawW && !rawH) {
    return null;
  }
  return defaultViewportFromEnv();
}

export async function connectBrowser(options: ConnectBrowserOptions = {}): Promise<Browser> {
  const useCloakBrowser = isCloakBrowserEnabled();

  let executablePath: string | undefined;
  if (useCloakBrowser) {
    // CloakBrowser 模式：优先使用隐身二进制
    executablePath =
      findCloakBrowserExecutable() ||
      options.executablePath?.trim() ||
      process.env.CHROME_PATH?.trim() ||
      process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
      findLocalChromiumExecutable();
  } else {
    executablePath =
      options.executablePath?.trim() ||
      process.env.CHROME_PATH?.trim() ||
      process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
      findLocalChromiumExecutable();
  }

  const envUserData = process.env.BOSS_BROWSER_USER_DATA_DIR?.trim();
  if (!envUserData) {
    ensureAppDataLayout();
  }
  const userDataDir =
    options.userDataDir?.trim() || envUserData || BROWSER_USER_DATA_DIR;

  const profileDirectory =
    options.profileDirectory?.trim() || process.env.BOSS_BROWSER_PROFILE_DIRECTORY?.trim();

  if (!executablePath) {
    if (useCloakBrowser) {
      throw new Error(
        '未找到 CloakBrowser 隐身浏览器二进制：请设置 CLOAKBROWSER_BINARY_PATH 指向 CloakBrowser 的 chrome 可执行文件，或运行 `npx cloakbrowser login` 下载二进制。',
      );
    } else {
      throw new Error(
        '未找到本机 Chrome/Edge：请设置 CHROME_PATH / PUPPETEER_EXECUTABLE_PATH（可执行文件路径）。',
      );
    }
  }

  const headless = options.headless ?? process.env.BOSS_BROWSER_HEADLESS === 'true';
  const allowAllCors = options.allowAllCors ?? process.env.BOSS_BROWSER_ALLOW_ALL_CORS === 'true';
  const disableGpu = process.env.BOSS_BROWSER_DISABLE_GPU === 'true';

  clearSpawnedChromeProcessRef();
  lastChromeLaunchHeadless = !!headless;

  /**
   * 优先直连固定调试端口上的已有实例：boss-cli 使用独立 user-data-dir，
   * 端口稳定可期，命中即跨命令复用同一只浏览器（同一登录态、同一标签）。
   */
  const existingWsUrl = await probeRemoteDebuggingWsEndpoint(REMOTE_DEBUGGING_PORT, 800);
  if (existingWsUrl) {
    const existing = await puppeteer.connect({
      browserWSEndpoint: existingWsUrl,
      defaultViewport: launchViewportFromEnv(),
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    });
    await assertCdpResponsive(existing);
    return existing;
  }

  // 默认保留 WebAssembly：`typeof WebAssembly === 'undefined'` 本身就是强自动化指纹。
  // aegis_bg.wasm 已在 CDP `Fetch.enable` 层被阻断，不需要再禁用 WASM 引擎。
  // 仅当显式设置 BOSS_BROWSER_DISABLE_WASM=true/1 时才追加 --noexpose_wasm。
  const disableWasm = process.env.BOSS_BROWSER_DISABLE_WASM === 'true' || process.env.BOSS_BROWSER_DISABLE_WASM === '1';
  const userArgs = [
    ...LAUNCH_ARGS_LESS_AUTOMATION,
    ...(disableGpu ? ['--disable-gpu'] : []),
    ...(disableWasm ? ['--js-flags=--noexpose_wasm'] : []),
    ...(allowAllCors ? LAUNCH_ARGS_ALLOW_ALL_CORS : []),
    ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
  ];

  let chromeArgs = puppeteer
    .defaultArgs({
      browser: 'chrome',
      userDataDir,
      headless,
      args: userArgs,
    })
    .filter((a) => a !== '--enable-automation' && a !== 'about:blank' && a !== 'data:,');

  if (!chromeArgs.some((a) => a.startsWith('--remote-debugging-'))) {
    chromeArgs.push(`--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`);
  }

  // ─── CloakBrowser: 注入隐身启动参数 ───────────────────────────────────────
  if (useCloakBrowser) {
    const stealthArgs = getCloakBrowserStealthArgs();
    // 避免与已有参数重复
    for (const arg of stealthArgs) {
      const key = arg.split('=')[0];
      if (!chromeArgs.some(a => a.startsWith(key!))) {
        chromeArgs.push(arg);
      }
    }
    console.error(`[boss-cli] CloakBrowser 隐身模式已启用 (executable: ${executablePath})`);
  }

  // ─── 额外启动参数（诊断用，来自 BOSS_BROWSER_EXTRA_ARGS）───────────────────
  const extraArgs = readExtraChromeArgs();
  if (extraArgs.length > 0) {
    const applied: string[] = [];
    for (const arg of extraArgs) {
      const key = arg.split('=')[0];
      if (chromeArgs.some((a) => a.startsWith(key!))) {
        // 已有同名参数就不覆盖，但要说出来：否则会以为诊断开了、其实没生效
        console.error(`[boss-cli] 额外启动参数 ${key} 已存在于默认参数中，本次忽略：${arg}`);
        continue;
      }
      chromeArgs.push(arg);
      applied.push(arg);
    }
    if (applied.length > 0) {
      console.error(`[boss-cli] 已附加额外启动参数：${applied.join(' ')}`);
    }
  }

  /**
   * 不使用 `puppeteer.launch()`：其依赖的 `@puppeteer/browsers` 会在 **Node 进程 `exit` 时 kill 浏览器子进程**，
   * 导致交互模式 / `npm run dev` 退出时窗口被一并关掉。改为自行 `spawn` + `connect`，退出时只断 CDP，浏览器可保留。
   */
  const proc = spawn(executablePath, chromeArgs, {
    detached: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  spawnedChromeChild = proc;

  let wsUrl: string;
  try {
    wsUrl = await waitForDevToolsWebSocketUrl(proc, userDataDir, LAUNCH_READY_MS);
  } catch (e) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    clearSpawnedChromeProcessRef();
    throw e;
  }

  try {
    proc.stdout?.resume();
    proc.stderr?.resume();
  } catch {
    /* ignore */
  }
  /** 单例移交时子进程已退出，无句柄可 unref；仅在本进程真正拉起 Chrome 时 unref，避免拖住 Node 退出。 */
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.unref();
    } catch {
      /* ignore */
    }
  } else {
    clearSpawnedChromeProcessRef();
  }

  try {
    return await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: launchViewportFromEnv(),
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    });
  } catch (e) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    clearSpawnedChromeProcessRef();
    throw e;
  }
}

/** 对某一页创建原生 CDP Session（需要低层域如 `Network.*`、`Fetch.*` 时使用）。 */
export async function createPageCDPSession(page: Page): Promise<CDPSession> {
  return page.createCDPSession();
}
