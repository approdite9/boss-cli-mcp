/**
 * 跨进程会话冲突的可见化。
 *
 * 背景：`common/boss_session_lock.ts` 是一把**跨进程文件锁**（`~/.boss-cli/.cache/session.lock`），
 * 等不到 30s 就抛一条英文错误。触发它的典型场景是：
 * - 同时开了两个 MCP 客户端（各自拉起一个 boss-mcp 进程）；
 * - 一边用 MCP，一边在终端敲 `boss xxx`。
 *
 * 进程内的串行队列管不了这些，锁本身也在共享层（改它会连带影响 CLI），所以这里只做两件事：
 * 1. 启动时检测是否已有另一个存活的 boss-mcp 实例，立刻在 stderr 告警——把「稍后莫名 30s 超时」
 *    提前变成「启动时就看到原因」。
 * 2. 把那条英文锁错误改写成中文可操作指引（保留原始信息里的 pid / 锁文件路径）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { formatLoggedOutMessage, isOutsideBossShellUrl } from '../common/auth.js';
import { CACHE_DIR } from '../config.js';

const INSTANCE_FILE = join(CACHE_DIR, 'mcp-server.pid');
const SESSION_LOCK_FILE = join(CACHE_DIR, 'session.lock');

type InstanceMeta = {
  pid: number;
  hostname: string;
  startedAt: string;
};

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 说明进程存在但无权发信号，仍算存活
    const code = e && typeof e === 'object' && 'code' in e ? e.code : '';
    return code === 'EPERM';
  }
}

function readInstanceMeta(): InstanceMeta | null {
  if (!existsSync(INSTANCE_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(INSTANCE_FILE, 'utf8')) as Partial<InstanceMeta>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

export type InstanceCheckResult = {
  /** 已存在的另一个存活实例（同机器）；没有则为 null */
  conflict: InstanceMeta | null;
};

/**
 * 登记当前进程为 boss-mcp 实例，并报告是否已有另一个存活实例。
 * 刻意**不阻止启动**：陈旧 pid 文件、用户有意开两个，都不该让 server 起不来。
 */
export function registerInstance(): InstanceCheckResult {
  let conflict: InstanceMeta | null = null;
  const existing = readInstanceMeta();
  if (existing && existing.pid !== process.pid && existing.hostname === hostname()) {
    if (processAlive(existing.pid)) {
      conflict = existing;
    }
  }

  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    const meta: InstanceMeta = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(INSTANCE_FILE, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  } catch {
    /* 登记失败不影响主流程 */
  }

  return { conflict };
}

/** 退出时清掉自己的登记（只在确实是自己写的时候删） */
export function unregisterInstance(): void {
  try {
    const meta = readInstanceMeta();
    if (meta && meta.pid === process.pid) {
      rmSync(INSTANCE_FILE, { force: true });
    }
  } catch {
    /* ignore */
  }
}

export function formatInstanceConflictWarning(conflict: InstanceMeta): string {
  return [
    `[boss-mcp] ⚠️ 检测到本机已有另一个 boss-mcp 实例在运行（pid=${conflict.pid}${conflict.startedAt ? `，启动于 ${conflict.startedAt}` : ''}）。`,
    '[boss-mcp]   两个实例会共用同一只 Chrome，并通过跨进程文件锁互相等待，表现为工具调用 30 秒后报 “session is busy”。',
    '[boss-mcp]   建议只保留一个 MCP 客户端连接 boss-mcp；本实例仍会继续启动。',
  ].join('\n');
}

/** 共享层那条锁超时错误的特征（见 common/boss_session_lock.ts） */
function isSessionBusyMessage(message: string): boolean {
  return message.includes('Boss session is busy');
}

/**
 * 把英文锁错误改写成可操作的中文指引。非该类错误返回 null（调用方保持原样）。
 * 纯函数，便于单测。
 */
export function rewriteSessionBusyMessage(message: string): string | null {
  if (!isSessionBusyMessage(message)) {
    return null;
  }
  const pid = /pid=(\d+)/.exec(message)?.[1];
  const cmd = /cmd=([^,]+)/.exec(message)?.[1]?.trim();

  return [
    '❌ Boss 会话被另一个进程占用超过 30 秒，本次调用未执行。',
    pid ? `占用者：pid=${pid}${cmd ? `，命令=${cmd}` : ''}` : '',
    '',
    '常见原因（三选一）：',
    '1) 同时开了两个 MCP 客户端，各自拉起了一个 boss-mcp——只保留一个即可；',
    '2) 你正在终端里跑 boss 命令（CLI 与 MCP 共用同一把会话锁）——等它结束后重试；',
    '3) 之前的进程异常退出留下了残留锁——删除锁文件后重试：',
    `   ${SESSION_LOCK_FILE}`,
    '',
    '（原始信息已保留在上方 pid/命令中，便于确认到底是谁占用。）',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * puppeteer 在目标 frame 被卸载时抛的原文特征。
 * 典型场景：读推荐列表途中，当前标签被导航到别的页面（`recommendFrame` 随之消失）。
 */
function isDetachedFrameMessage(message: string): boolean {
  return (
    message.includes('frame got detached') ||
    message.includes('Attempted to use detached Frame') ||
    message.includes('Execution context was destroyed')
  );
}

/**
 * 把「frame 已卸载」改写成可操作指引，并**显式劝阻调用登录工具**。
 *
 * 为什么要专门写这一句：审计日志里出现过自我强化的失败循环——
 * `boss_recommend` 报 `frame got detached`，Agent 判断成「可能未登录」于是调 `boss_login`，
 * 而 `boss_login` 会把当前标签导航到登录页，把推荐列表彻底弄掉，下一次 `boss_recommend`
 * 必然再次 detached。原始英文错误里没有任何信息能让 Agent 避开这个坑。
 */
export function rewriteDetachedFrameMessage(message: string): string | null {
  if (!isDetachedFrameMessage(message)) {
    return null;
  }
  return [
    '❌ 目标页面在操作过程中被导航或刷新，当前列表上下文已失效，本次调用未完成。',
    '',
    '当前页面不是登录页，所以**不要因此调用 boss_login**——它会把当前标签导航到登录页，',
    '反而让推荐/搜索列表彻底丢失，下一次读取仍会失败。',
    '',
    '推荐列表是易失的：一旦页面被导航走，本轮筛选需要重新开始（重新读取列表，不要沿用旧序号）。',
    '',
    `（原始信息：${message}）`,
  ].join('\n');
}

/**
 * 统一的错误文案增强入口：命中已知模式就改写，否则原样返回。
 *
 * `currentPageUrl` 由调用方在出错的**那一刻**读出来。有它才能分开两件长得一样的事：
 * 页面被导航走（列表丢了，别去登录）与登录态失效（唯一的解法就是重新登录）。
 * 两者都会让 frame 卸载，原先只按错误文本判断，于是登录掉线时照样输出
 * 「这与登录态无关，不要调 boss_login」——把唯一的解法排除掉了。
 * 登录判定必须排在最前：它是根因，其它文案都只是它的下游现象。
 */
export function enhanceToolErrorMessage(message: string, currentPageUrl?: string): string {
  // 判据是「不在 /web/chat/* 主壳里」，不是「URL 等于登录页」：
  // 实测票据失效时 Boss 更常把 B 端会话弹到首页 https://www.zhipin.com/，
  // 只认 /web/user/ 会漏掉主要路径。
  if (currentPageUrl && isOutsideBossShellUrl(currentPageUrl)) {
    return `${formatLoggedOutMessage(currentPageUrl)}\n\n（原始信息：${message}）`;
  }
  return rewriteSessionBusyMessage(message) ?? rewriteDetachedFrameMessage(message) ?? message;
}
