/**
 * 故障现场存档。
 *
 * 为什么需要它：僵死类故障的根因至今没查到，而每次它发生时**现场都会被清掉**——
 * 浏览器重启、标签被关、日志被后续内容顶掉，于是每次都只剩一句错误信息可看。
 * 剩下两个互相矛盾的候选，各自有明确签名，但都必须在**故障当时**采样才分得清：
 *
 *   - 标签被丢弃：渲染进程工作集从 ~190MB 塌到个位数 MB，CPU 归零
 *   - 主线程被页面 JS 堵死：工作集正常，某个渲染进程 CPU 几乎跑满一核
 *
 * 所以这里在故障发生的那一刻，把「两次相隔数秒的进程采样」连同标签表和日志尾巴一起
 * 落到磁盘。下一次自然发生时，不用再靠回忆和猜。
 *
 * 三条约束：
 * 1. **绝不影响主流程**。存档失败只记一条日志，不往上抛——因为取证不成功而让一次工具调用
 *    失败是本末倒置。但也不静默：失败原因会写进 `mcp-server.log`，这是本仓库一贯要求的。
 * 2. **有节流**。僵死会让每个标签各报一次，看门狗每次调用报一次；同一类故障 5 分钟内只存一份，
 *    否则一次持续 54 分钟的僵死能刷出上百个目录，反而把现场埋掉。
 * 3. **有上限**。日志尾巴只读文件末尾若干字节（`chrome_debug.log` 会长到几百 MB，
 *    整文件读进内存会把这台 5GB 内存的机器压垮），保留目录数也有上限。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { LOGS_DIR } from '../config.js';

/** 故障类别。每一类的签名不同，分开节流。 */
export type IncidentKind =
  /** 页面防护注入卡住：某个标签的渲染进程不响应 CDP */
  | 'guard-step-timeout'
  /** 浏览器整体不响应 CDP（端口能连、命令不回） */
  | 'cdp-unresponsive'
  /** 单次工具调用超过看门狗上限仍未返回 */
  | 'tool-watchdog';

const INCIDENT_DIR = join(LOGS_DIR, 'incident');

/** 同类故障的最小存档间隔。 */
const THROTTLE_MS = 5 * 60 * 1000;
/** 保留的存档目录数上限。 */
const KEEP_DIRS = 20;
/** 日志尾巴：读文件末尾这么多字节。 */
const TAIL_BYTES = 512 * 1024;
/** 日志尾巴：保留最后这么多行。 */
const TAIL_LINES = 400;
/** 两次进程采样的间隔。CPU 增量要靠它算出来。 */
const PROCESS_SAMPLE_GAP_MS = 2_000;

const lastCaptureAt = new Map<IncidentKind, number>();

/**
 * 当前正在执行的工具名。
 *
 * 由 MCP 层在每次调用开始时写入。放在这里而不是 `mcp/tool_metrics.ts`，是为了不让
 * `common` 反向依赖 `mcp`：这里是唯一的消费者，而 `mcp` 依赖 `common` 是正确方向。
 * 僵死是在 `boss_page_guards` 深处被发现的，那里拿不到工具上下文，
 * 之前存档只能写「工具 = (未知)」——而这是排查时第一个要问的问题。
 */
let currentToolName = '';

export function setCurrentToolName(name: string): void {
  currentToolName = name;
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 读文件末尾。
 *
 * 不用 `readFileSync`：`chrome_debug.log` 开了 verbose 后按每分钟约 45KB 增长，
 * 且 Chrome 只在浏览器重启时才截断它，浏览器可以连开好几天。
 */
function tailLines(file: string, keepLines = TAIL_LINES, filter?: (line: string) => boolean): string {
  if (!existsSync(file)) {
    return `(文件不存在：${file})`;
  }
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const readLen = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(readLen);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, readLen, size - readLen);
    const text = buf.toString('utf8');
    // 从文件中间开始读，第一行大概率是残的，丢掉
    const lines = text.split(/\r?\n/).slice(size > readLen ? 1 : 0);
    const kept = filter ? lines.filter(filter) : lines;
    const head = `# 源文件 ${file}（共 ${size} 字节，只取末尾 ${readLen} 字节${filter ? '，已过滤' : ''}）\n`;
    return head + kept.slice(-keepLines).join('\n');
  } catch (e) {
    return `(读取失败：${file} —— ${e instanceof Error ? e.message : String(e)})`;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

type ChromeProcess = {
  pid: number;
  type: string;
  cpuSeconds: number | null;
  workingSetMB: number | null;
};

/**
 * 采一次 Chrome 进程快照，顺带把调试端口读出来。
 *
 * 为什么走 PowerShell 而不是 CDP 的 `SystemInfo.getProcessInfo`：后者只给 cpuTime，
 * 不给工作集，而「工作集塌到个位数 MB」正是标签被丢弃那一侧最有力的证据。
 * 另外这里刻意不碰 puppeteer：僵死时任何需要 attach 的路径都可能挂住，
 * 而取证代码本身绝不能被它要记录的故障卡死。
 */
function sampleChromeProcesses(): { procs: ChromeProcess[]; debugPort: number | null; note?: string } {
  if (process.platform !== 'win32') {
    return { procs: [], debugPort: null, note: '非 Windows 平台，未采集进程快照' };
  }
  const script = `
$ErrorActionPreference='SilentlyContinue'
$out = @()
foreach ($w in (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'")) {
  $p = Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue
  $type = 'browser'
  if ($w.CommandLine -match '--type=([a-z\\-]+)') { $type = $matches[1] }
  $port = ''
  if ($w.CommandLine -match '--remote-debugging-port=(\\d+)') { $port = $matches[1] }
  $out += [pscustomobject]@{ pid = $w.ProcessId; type = $type; cpu = $(if ($p) { $p.CPU } else { $null }); ws = $(if ($p) { [math]::Round($p.WorkingSet64 / 1MB, 1) } else { $null }); port = $port }
}
$out | ConvertTo-Json -Compress
`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (r.error || !r.stdout?.trim()) {
    return { procs: [], debugPort: null, note: `进程快照采集失败：${r.error?.message ?? r.stderr ?? '无输出'}` };
  }
  try {
    const raw = JSON.parse(r.stdout) as unknown;
    const arr = (Array.isArray(raw) ? raw : [raw]) as Array<{
      pid: number;
      type: string;
      cpu: number | null;
      ws: number | null;
      port: string;
    }>;
    const port = arr.map((x) => Number.parseInt(x.port, 10)).find((n) => Number.isFinite(n) && n > 0) ?? null;
    return {
      procs: arr.map((x) => ({ pid: x.pid, type: x.type, cpuSeconds: x.cpu, workingSetMB: x.ws })),
      debugPort: port,
    };
  } catch (e) {
    return { procs: [], debugPort: null, note: `进程快照解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

function renderProcessReport(a: ChromeProcess[], b: ChromeProcess[], gapMs: number, note?: string): string {
  const lines = [
    `# Chrome 进程两次采样，间隔 ${gapMs}ms`,
    '#',
    '# 怎么读：',
    '#   某个 renderer 的 cpuΔ 接近 gap（几乎跑满一核）→ 主线程被页面 JS 堵死',
    '#   某个 renderer 的 cpuΔ≈0 且 ws 只有个位数到二十几 MB → 标签被丢弃/回收',
    '#   （正常渲染一张 Boss 页面的 renderer 工作集在 100MB 量级）',
    '',
    'pid'.padStart(7) + 'type'.padStart(18) + 'cpu1(s)'.padStart(10) + 'cpu2(s)'.padStart(10) + 'cpuΔ(s)'.padStart(10) + 'ws1(MB)'.padStart(10) + 'ws2(MB)'.padStart(10),
  ];
  const byPid = new Map(b.map((p) => [p.pid, p]));
  for (const p of a) {
    const q = byPid.get(p.pid);
    const d = p.cpuSeconds !== null && q?.cpuSeconds !== undefined && q?.cpuSeconds !== null
      ? (q.cpuSeconds - p.cpuSeconds).toFixed(2)
      : '-';
    lines.push(
      String(p.pid).padStart(7) +
        p.type.padStart(18) +
        String(p.cpuSeconds ?? '-').padStart(10) +
        String(q?.cpuSeconds ?? '-').padStart(10) +
        d.padStart(10) +
        String(p.workingSetMB ?? '-').padStart(10) +
        String(q?.workingSetMB ?? '-').padStart(10),
    );
  }
  const gone = b.filter((p) => !a.some((x) => x.pid === p.pid));
  if (gone.length > 0) {
    lines.push('', '两次采样之间新出现的进程：' + gone.map((p) => `${p.pid}(${p.type})`).join('、'));
  }
  if (note) {
    lines.push('', '注意：' + note);
  }
  return lines.join('\n');
}

async function fetchTargets(debugPort: number | null): Promise<string> {
  if (!debugPort) {
    return '(没能从 Chrome 命令行里读到 --remote-debugging-port，未采集标签表)';
  }
  // 用 HTTP 端点：它由浏览器进程的独立线程伺服，某个渲染进程僵死不影响它，
  // 而且不会 attach 任何 target（attach 本身就可能被僵死卡住）。
  try {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(8_000) });
    const list = (await res.json()) as Array<{ id: string; type: string; url: string; title?: string }>;
    const lines = list.map((t) => `${t.type.padEnd(10)} ${t.id} ${t.url}`);
    return `# /json/list 共 ${list.length} 个 target\n` + lines.join('\n');
  } catch (e) {
    return `(取标签表失败：${e instanceof Error ? e.message : String(e)})`;
  }
}

/** 超出保留上限时删掉最老的存档目录。 */
function pruneOldIncidents(): void {
  const dirs = readdirSync(INCIDENT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of dirs.slice(0, Math.max(0, dirs.length - KEEP_DIRS))) {
    rmSync(join(INCIDENT_DIR, name), { recursive: true, force: true });
  }
}

export type CaptureIncidentOptions = {
  /** 触发存档的工具名（有的话） */
  toolName?: string;
  /** 卡住的页面 URL（有的话） */
  pageUrl?: string;
};

/**
 * 存一份故障现场。返回存档目录，未存（被节流）时返回 null。
 *
 * 调用方一律用 `void captureIncident(...)` 即发即忘：它自己保证不抛、不阻塞主流程。
 */
export async function captureIncident(
  kind: IncidentKind,
  detail: string,
  options: CaptureIncidentOptions = {},
): Promise<string | null> {
  const now = Date.now();
  const last = lastCaptureAt.get(kind);
  if (last !== undefined && now - last < THROTTLE_MS) {
    return null;
  }
  lastCaptureAt.set(kind, now);

  try {
    const dir = join(INCIDENT_DIR, `${nowStamp()}-${kind}`);
    mkdirSync(dir, { recursive: true });

    const s1 = sampleChromeProcesses();
    await new Promise((r) => setTimeout(r, PROCESS_SAMPLE_GAP_MS));
    const s2 = sampleChromeProcesses();

    const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`;
    writeFileSync(
      join(dir, 'summary.txt'),
      [
        `时间：${new Date().toISOString()}`,
        `类别：${kind}`,
        `工具：${options.toolName || currentToolName || '(未知)'}`,
        `页面：${options.pageUrl ?? '(未知)'}`,
        '',
        '错误信息：',
        detail,
        '',
        `node 进程 rss=${mb(process.memoryUsage().rss)}；整机空闲 ${mb(freemem())}/${mb(totalmem())}`,
        `Chrome 调试端口：${s1.debugPort ?? '(未读到)'}`,
        `Chrome 进程数：${s1.procs.length}`,
        '',
        '同目录下：',
        '  processes.txt        两次进程采样与 CPU 增量（区分「标签被丢弃」和「主线程被堵死」）',
        '  targets.txt          当次的标签表',
        '  mcp-server.tail.log  服务日志尾巴',
        '  mcp-audit.tail.log   工具调用审计尾巴',
        '  chrome_debug.tail.log  Chrome 详细日志尾巴（已剔除 INFO:CONSOLE 页面噪声）',
      ].join('\n'),
      'utf8',
    );

    writeFileSync(
      join(dir, 'processes.txt'),
      renderProcessReport(s1.procs, s2.procs, PROCESS_SAMPLE_GAP_MS, s1.note ?? s2.note),
      'utf8',
    );
    writeFileSync(join(dir, 'targets.txt'), await fetchTargets(s1.debugPort), 'utf8');
    writeFileSync(join(dir, 'mcp-server.tail.log'), tailLines(join(LOGS_DIR, 'mcp-server.log')), 'utf8');
    writeFileSync(join(dir, 'mcp-audit.tail.log'), tailLines(join(LOGS_DIR, 'mcp-audit.log')), 'utf8');
    // Chrome 详细日志里 6535 行有 6527 行是页面 console 输出（反调试代码在紧循环里调
    // console.log），不剔掉的话尾巴里全是噪声、真正的 discard/hang 记录一条都留不下。
    writeFileSync(
      join(dir, 'chrome_debug.tail.log'),
      tailLines(join(LOGS_DIR, 'chrome_debug.log'), TAIL_LINES, (l) => !l.includes('INFO:CONSOLE')),
      'utf8',
    );

    pruneOldIncidents();
    console.error(`[boss-cli] 已存故障现场：${dir}（类别 ${kind}）`);
    return dir;
  } catch (e) {
    // 取证失败不能影响主流程，但原因必须留下——这一路都在要求这件事。
    console.error(`[boss-cli] 故障现场存档失败（不影响本次调用）：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
