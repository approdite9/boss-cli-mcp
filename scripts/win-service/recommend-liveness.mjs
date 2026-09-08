/**
 * 推荐页存活巡检（工作时段每 N 分钟一次）。
 *
 * 针对的场景：AI 筛人要几十分钟，这段时间推荐页在后台闲置；等到要打招呼时才发现
 * 渲染进程已经僵死，于是白等一次超时、白筛一轮。实测过的两条现场：
 *   - `Page.addScriptToEvaluateOnNewDocument timed out`（王理安、杨丽桦，各连续 2 次）
 *   - 卡死一旦发生就持续数十分钟不自愈，只有换标签或重启浏览器才恢复
 *
 * 默认**只探活、只报告，不做任何修复**。探活是对推荐页发一条最轻的 evaluate（带超时），
 * 不导航、不点击、不刷新——实测连续多轮标签集合完全不变。它同时起到保活作用：
 * `chrome://discards` 显示「有 CDP 客户端连着」的标签被标为不可丢弃、不可冻结。
 *
 * 为什么恢复默认关闭（`--recover` 才开）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 恢复动作是「新开推荐页标签 → 关掉僵死的旧标签」，它有三重代价，其中一条尚未验证：
 *
 *   1. 会重新加载推荐列表，等着被打招呼的 geekId 大概率失效。僵死时列表本来已不可用，
 *      这条还算可接受。
 *   2. 新建标签会触发 `boss_page_guards` 的 `targetcreated` 注入——而那正是本项目
 *      判定的打招呼卡死机制。用一个会引发该故障的动作去修该故障，逻辑上就不成立。
 *   3. **未验证**：新开的 `/web/chat/recommend` 落在哪个岗位不确定。若它不是「上次选中的
 *      岗位」而是默认岗位，恢复就等于**静默切换岗位**——而真实流程里岗位由工作流钉住、
 *      全程不切。静默切岗位会让整批筛选结果对不上，比卡死本身更糟。
 *
 * 所以定位改成「早发现 + 如实报告」：卡死在你用到之前就被记进日志，怎么处置由人决定。
 * 要开恢复必须显式传 `--recover`，并且先把第 3 条验证掉。
 *
 * 用法（计划任务只跑第一条）：
 *   node scripts/win-service/recommend-liveness.mjs
 *   node scripts/win-service/recommend-liveness.mjs --recover
 *
 * 退出码：0 健康 / 4 发现僵死（或已恢复）/ 3 本轮跳过（忙 / 未登录 / 浏览器不可用）/ 1 脚本自身出错
 */

import { appendFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CDP_PORT = Number(process.env.BOSS_BROWSER_REMOTE_DEBUGGING_PORT?.trim() || '53470');
const RECOMMEND_URL = 'https://www.zhipin.com/web/chat/recommend';

/**
 * 探活超时。正常 evaluate 是毫秒级；给到 8 秒是为页面正忙留余量。
 * 超过这个量级就按僵死处理——实测僵死是「永远不返回」，不是「慢一点」。
 */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * 「服务正忙」判定窗口。比看守用的 10 分钟短：巡检要频繁跑，等 10 分钟无事可做太浪费；
 * 但仍必须避开真实调用——同一个 Chrome 上两个 CDP 客户端同时操作会把服务持有的连接搞坏。
 */
const BUSY_WINDOW_MS = 90 * 1000;

const LOG_DIR = path.join(os.homedir(), '.boss-cli', 'logs');
const JSONL = path.join(LOG_DIR, 'recommend-liveness.jsonl');
const AUDIT_LOG = path.join(LOG_DIR, 'mcp-audit.log');

function nowIso() {
  return new Date().toISOString();
}

async function log(record) {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(JSONL, JSON.stringify({ ts: nowIso(), ...record }) + '\n', 'utf8');
}

function say(s) {
  console.log(`[recommend-liveness] ${s}`);
}

async function serverBusy() {
  try {
    const st = await stat(AUDIT_LOG);
    const idleMs = Date.now() - st.mtimeMs;
    return { busy: idleMs < BUSY_WINDOW_MS, idleMs };
  } catch {
    return { busy: false, idleMs: null };
  }
}

async function cdp(pathname, init) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, {
    signal: AbortSignal.timeout(10_000),
    ...init,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function listPages() {
  const all = await cdp('/json/list');
  if (!Array.isArray(all)) throw new Error(`/json/list 返回异常：${String(all).slice(0, 120)}`);
  return all.filter((t) => t.type === 'page');
}

/**
 * 直接用 WebSocket 发一条 `Runtime.evaluate`，不经 puppeteer。
 *
 * 刻意不用 puppeteer：`puppeteer.connect` 会 attach 所有 target 并对每个发 `Network.enable`，
 * 任何一个标签僵死都会把整个连接拖死——巡检的目的就是查僵死，工具本身不能被僵死卡住。
 * 裸 WebSocket 只跟目标标签的 session 说话，隔离得干净。
 */
function probeTarget(wsUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch { /* 已关就算了 */ }
      resolve(result);
    };
    const timer = setTimeout(() => done({ alive: false, reason: 'probe-timeout' }), PROBE_TIMEOUT_MS);
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      clearTimeout(timer);
      return resolve({ alive: false, reason: `ws-open-failed: ${e.message}` });
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.error) return done({ alive: false, reason: `evaluate-error: ${msg.error.message}` });
      const v = msg.result?.result?.value;
      done(v === 2 ? { alive: true } : { alive: false, reason: `unexpected-value: ${JSON.stringify(v)}` });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done({ alive: false, reason: 'ws-error' });
    };
    ws.onclose = () => {
      clearTimeout(timer);
      done({ alive: false, reason: 'ws-closed' });
    };
  });
}

function looksLoggedOut(url) {
  return /\/web\/user\/?\?|ka=header-login|ka=bticket/.test(url);
}

async function main() {
  // 默认不恢复：见文件头「为什么恢复默认关闭」
  const allowRecover = process.argv.includes('--recover');

  const busy = await serverBusy();
  if (busy.busy) {
    say(`跳过：${Math.round((busy.idleMs ?? 0) / 1000)}s 前有真实调用，避开 CDP 争用`);
    await log({ action: 'skip', reason: 'server-busy', idleMs: busy.idleMs });
    process.exit(3);
  }

  let pages;
  try {
    pages = await listPages();
  } catch (e) {
    say(`跳过：浏览器不可用 —— ${e.message}`);
    await log({ action: 'skip', reason: 'browser-unavailable', detail: e.message });
    process.exit(3);
  }

  // 只巡检推荐页；看守自己那个 favicon 标签和别的页面不在范围内
  const targets = pages.filter((p) => p.url.includes('/web/chat/recommend'));
  if (targets.length === 0) {
    const loggedOut = pages.some((p) => looksLoggedOut(p.url));
    say(loggedOut ? '跳过：当前未登录' : '跳过：当前没有推荐页标签（不在推荐流程中）');
    await log({
      action: 'skip',
      reason: loggedOut ? 'logged-out' : 'no-recommend-tab',
      tabs: pages.map((p) => p.url.slice(0, 120)),
    });
    process.exit(3);
  }

  const results = [];
  for (const t of targets) {
    const r = await probeTarget(t.webSocketDebuggerUrl);
    results.push({ id: t.id, url: t.url, ...r });
    say(`探活 ${t.id.slice(0, 8)} ${t.url.slice(0, 60)} → ${r.alive ? '存活' : '僵死(' + r.reason + ')'}`);
  }

  const dead = results.filter((r) => !r.alive);
  if (dead.length === 0) {
    await log({ action: 'probe', healthy: true, tabs: results.length });
    say('全部存活');
    process.exit(0);
  }

  if (!allowRecover) {
    await log({
      action: 'probe',
      healthy: false,
      dead: dead.map((d) => ({ url: d.url, reason: d.reason })),
      note: '默认不恢复：换标签会重载列表、会触发 targetcreated 注入，且新标签落在哪个岗位未验证',
    });
    say(`发现 ${dead.length} 个僵死的推荐页标签，已记入日志。未传 --recover，不做任何修复。`);
    say('处置建议：确认当前岗位后手动新开推荐页标签并关掉僵死的那个，或重启浏览器。');
    process.exit(4);
  }

  // ── 恢复（仅 --recover）：先建新标签，再关僵死的。
  // 顺序很重要——先关可能让 Chrome 只剩零个标签而退出。
  // 注意这条路径会重载列表、可能改变选中岗位，调用方必须清楚自己在做什么。
  say('⚠️ --recover 已开：即将新建推荐页标签并关闭僵死标签。列表会重载，选中岗位可能改变。');
  let created = null;
  try {
    created = await cdp(`/json/new?${encodeURIComponent(RECOMMEND_URL)}`, { method: 'PUT' });
  } catch (e) {
    say(`新建标签失败：${e.message}`);
    await log({ action: 'recover', ok: false, stage: 'new-tab', detail: e.message });
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 8000));

  const closed = [];
  for (const d of dead) {
    try {
      await cdp(`/json/close/${d.id}`);
      closed.push(d.url);
    } catch (e) {
      say(`关闭 ${d.id.slice(0, 8)} 失败：${e.message}`);
    }
  }

  // 确认新标签真的活着，否则「恢复成功」就是句空话
  await new Promise((r) => setTimeout(r, 3000));
  const after = await listPages().catch(() => []);
  const fresh = after.find((p) => p.id === created?.id);
  const freshProbe = fresh ? await probeTarget(fresh.webSocketDebuggerUrl) : { alive: false, reason: 'new-tab-missing' };

  await log({
    action: 'recover',
    ok: freshProbe.alive,
    deadCount: dead.length,
    closed,
    newTabAlive: freshProbe.alive,
    newTabReason: freshProbe.reason ?? null,
    note: '换标签会让推荐列表重新加载，等待打招呼的 geekId 可能失效——但僵死时列表本来已不可用',
  });

  if (!freshProbe.alive) {
    say(`恢复失败：新标签也不可用（${freshProbe.reason}）。需要重启浏览器。`);
    process.exit(1);
  }
  say(`恢复完成：关掉 ${closed.length} 个僵死标签，新标签存活。注意推荐列表已重新加载。`);
  process.exit(4);
}

main().catch(async (e) => {
  console.error(`[recommend-liveness] 未预期错误：${e.stack || e.message}`);
  await log({ action: 'error', detail: e.message }).catch(() => {});
  process.exit(1);
});
