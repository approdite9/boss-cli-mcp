#!/usr/bin/env node
/**
 * Boss 前端 DOM Selector 健康检测脚本（独立手动运行）
 *
 * 安全设计：
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ✅ 零额外网络请求 — 连接已运行的 boss-cli 浏览器，只读当前页面 DOM
 * ✅ 无额外页面加载 — 不 navigate、不 reload、不打开新 tab
 * ✅ 无 DOM 修改    — 纯 querySelectorAll 只读
 * ✅ 无事件触发    — 不 click、不 scroll、不 input
 * ✅ 无计时特征    — 一次性运行完退出，无周期性行为
 * ✅ CDP 本地通信  — 等同用户在 DevTools Console 执行代码
 *
 * 用法：
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --port 53470
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --snapshot  (保存结构快照供 diff)
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --diff      (与上次快照对比)
 *
 * 前提：boss-cli 浏览器已打开且推荐页已加载（运行过 boss_recommend 即可）
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  配置：与 recommend.ts 中硬编码的 selector 保持一致
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CRITICAL_SELECTORS = {
  // — 卡片容器 —
  cardRoot: '.candidate-card-wrap, .card-list .card-item, .geek-list .geek-card',
  cardInner: '.card-inner',

  // — 候选人数据字段 —
  geekIdAttr: '.card-inner[data-geekid], [data-geek]',
  name: '.name-wrap .name',
  nameFallback: '.name',
  salary: '.salary-wrap span',
  baseInfo: '.base-info span',
  expectContent: '.expect-wrap .content',
  joinTextWrap: '.join-text-wrap',
  eduWrap: '.edu-wrap',
  workExps: '.col-3 .timeline-wrap.work-exps .timeline-item',
  emptyWorkExp: '.col-3 .empty-work-exp',
  geekDesc: '.geek-desc .content',
  labelsOperate: '.operate .labels .label',
  tagsWrap: '.tags-wrap .tag-item',

  // — 交互按钮 —
  greetBtn: '.button-chat-wrap .btn.btn-greet',
  chatHistory: '.tooltip-wrap.chat-history .icon-chat-history',

  // — 状态标识 —
  hasViewed: '.candidate-card-wrap.has-viewed',

  // — 岗位选择器 —
  jobSelector: '.job-selecter-wrap .ui-dropmenu-label',

  // — 推荐 iframe —
  recommendIframe: 'iframe[src*="recommend"], iframe[name*="recommend"]',
};

// 快照输出目录
const SNAPSHOT_DIR = path.join('docs', 'research', 'dom-snapshots');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  参数解析
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseArgs(argv) {
  const opts = { port: 53470, snapshot: false, diff: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (argv[i] === '--snapshot') {
      opts.snapshot = true;
    } else if (argv[i] === '--diff') {
      opts.diff = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Boss DOM Selector 健康检测

用法:
  node check_dom_selectors.mjs [选项]

选项:
  --port <number>   boss-cli 浏览器调试端口 (默认 53470)
  --snapshot        保存当前 DOM 结构快照
  --diff            与最近一次快照对比差异
  --help            显示帮助

安全说明:
  此脚本连接已打开的 boss-cli 浏览器实例，仅通过 CDP 在页面内
  执行 querySelectorAll 只读操作。不发送任何网络请求，不修改 DOM，
  不触发任何用户事件。对 Boss 后端完全不可见。
`);
      process.exit(0);
    }
  }
  return opts;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CDP 连接（复用 boss-cli 已有浏览器）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getWsEndpoint(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.webSocketDebuggerUrl;
  } catch (e) {
    return null;
  }
}

async function getPageTargets(port) {
  const url = `http://127.0.0.1:${port}/json/list`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * 通过原生 WebSocket 直接向页面发送 CDP 命令。
 * 不依赖 puppeteer-core，避免引入额外依赖。
 */
function createCdpConnection(wsUrl) {
  return new Promise((resolve, reject) => {
    // Node 18+ 内置 WebSocket（如不可用则 fallback 报错）
    const WebSocketClass = globalThis.WebSocket ?? (await import('ws')).default;
    const ws = new WebSocketClass(wsUrl);
    let msgId = 0;
    const pending = new Map();

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++msgId;
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (data.id && pending.has(data.id)) {
        const { resolve: res, reject: rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(data.error.message));
        else res(data.result);
      }
    });

    ws.addEventListener('error', (e) => reject(new Error(`WebSocket error: ${e.message || e}`)));
    ws.addEventListener('close', () => {
      for (const { reject: rej } of pending.values()) rej(new Error('WebSocket closed'));
      pending.clear();
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  核心检测逻辑（在页面中执行的纯读代码）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 注入页面执行的检测函数（字符串形式，通过 Runtime.evaluate 发送）
 * 绝对只读：querySelectorAll + textContent + getAttribute
 */
function buildCheckExpression(selectors) {
  return `(function() {
    'use strict';
    var selectors = ${JSON.stringify(selectors)};
    var results = {};

    // 先检测是否在推荐页 iframe 内
    var doc = document;
    var inIframe = false;

    // 尝试在 top 页面找推荐 iframe
    var recFrame = doc.querySelector('iframe[src*="recommend"]');
    if (recFrame && recFrame.contentDocument) {
      doc = recFrame.contentDocument;
      inIframe = true;
    }

    for (var key in selectors) {
      var sel = selectors[key];
      try {
        var els = doc.querySelectorAll(sel);
        results[key] = {
          selector: sel,
          found: els.length,
          alive: els.length > 0,
          sampleText: els.length > 0
            ? (els[0].textContent || '').trim().slice(0, 50)
            : null,
        };
      } catch (e) {
        results[key] = {
          selector: sel,
          found: 0,
          alive: false,
          error: e.message,
        };
      }
    }

    // 额外收集：卡片容器内所有唯一 class 名
    var allClasses = [];
    var cardSel = selectors.cardRoot || '.candidate-card-wrap';
    var cards = doc.querySelectorAll(cardSel);
    if (cards.length > 0) {
      var classSet = {};
      var firstCard = cards[0];
      var allEls = firstCard.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var cl = allEls[i].classList;
        for (var j = 0; j < cl.length; j++) {
          classSet[cl[j]] = true;
        }
      }
      allClasses = Object.keys(classSet).sort();
    }

    // DOM 结构签名（前3层，tag + class）
    function getStructure(el, depth) {
      if (depth > 3 || !el) return null;
      var children = [];
      for (var i = 0; i < el.children.length && i < 20; i++) {
        var c = getStructure(el.children[i], depth + 1);
        if (c) children.push(c);
      }
      return {
        tag: el.tagName.toLowerCase(),
        classes: Array.from(el.classList).sort(),
        childCount: el.children.length,
        children: children,
      };
    }

    var structure = null;
    if (cards.length > 0) {
      structure = getStructure(cards[0], 0);
    }

    return {
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      inIframe: inIframe,
      cardCount: cards.length,
      selectorResults: results,
      allClasses: allClasses,
      cardStructure: structure,
    };
  })()`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  输出格式化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatHealthReport(data) {
  const lines = [];
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║     Boss DOM Selector 健康检测报告                          ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`📅 检测时间: ${data.timestamp}`);
  lines.push(`🌐 页面 URL: ${data.pageUrl}`);
  lines.push(`📦 iframe 内: ${data.inIframe ? '是' : '否（主页面）'}`);
  lines.push(`🃏 卡片数量: ${data.cardCount}`);
  lines.push('');

  const results = data.selectorResults;
  const alive = Object.entries(results).filter(([, v]) => v.alive);
  const broken = Object.entries(results).filter(([, v]) => !v.alive);

  lines.push(`━━━ ✅ 正常 (${alive.length}/${Object.keys(results).length}) ━━━`);
  for (const [key, val] of alive) {
    const sample = val.sampleText ? ` → "${val.sampleText}"` : '';
    lines.push(`  ✅ ${key.padEnd(20)} [${val.found}个]${sample}`);
  }

  if (broken.length > 0) {
    lines.push('');
    lines.push(`━━━ ❌ 失效 (${broken.length}/${Object.keys(results).length}) ━━━`);
    for (const [key, val] of broken) {
      const reason = val.error ? ` (${val.error})` : '';
      lines.push(`  ❌ ${key.padEnd(20)} ${val.selector}${reason}`);
    }
    lines.push('');
    lines.push('⚠️  上述 selector 在当前页面中未找到匹配元素！');
    lines.push('   可能原因: Boss 前端更新了 class 名 / DOM 结构');
    lines.push('   建议操作: 运行 --snapshot 保存当前结构，人工分析变化');
  } else {
    lines.push('');
    lines.push('🎉 所有 selector 均正常工作！');
  }

  if (data.cardCount === 0) {
    lines.push('');
    lines.push('⚠️  当前页面没有候选人卡片。');
    lines.push('   请确保已运行 boss_recommend 加载推荐列表后再执行检测。');
  }

  lines.push('');
  return lines.join('\n');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  快照 & Diff
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function todayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function saveSnapshot(data) {
  const date = todayDate();
  const dir = path.join(SNAPSHOT_DIR, date);
  await mkdir(dir, { recursive: true });

  const snapshotFile = path.join(dir, 'snapshot.json');
  await writeFile(snapshotFile, JSON.stringify(data, null, 2), 'utf8');

  // 单独保存 class 列表（方便 diff）
  const classFile = path.join(dir, 'classes.txt');
  await writeFile(classFile, (data.allClasses || []).join('\n') + '\n', 'utf8');

  // 保存可读报告
  const reportFile = path.join(dir, 'report.txt');
  await writeFile(reportFile, formatHealthReport(data), 'utf8');

  console.log(`\n📸 快照已保存到: ${dir}/`);
  console.log(`   - snapshot.json  (完整数据)`);
  console.log(`   - classes.txt    (class 名列表，可用于 diff)`);
  console.log(`   - report.txt     (可读报告)`);
}

async function diffWithPrevious(data) {
  const { readdirSync, existsSync } = await import('node:fs');

  if (!existsSync(SNAPSHOT_DIR)) {
    console.log('\n⚠️  尚无历史快照，请先运行 --snapshot');
    return;
  }

  const dirs = readdirSync(SNAPSHOT_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  if (dirs.length === 0) {
    console.log('\n⚠️  尚无历史快照，请先运行 --snapshot');
    return;
  }

  // 取最新快照
  const latestDir = dirs.at(-1);
  const prevFile = path.join(SNAPSHOT_DIR, latestDir, 'snapshot.json');
  let prevData;
  try {
    prevData = JSON.parse(await readFile(prevFile, 'utf8'));
  } catch {
    console.log(`\n⚠️  无法读取上次快照: ${prevFile}`);
    return;
  }

  console.log(`\n📊 与 ${latestDir} 快照对比:`);
  console.log('');

  // 1. Selector 状态变化
  const prevResults = prevData.selectorResults || {};
  const currResults = data.selectorResults || {};
  let changed = false;

  for (const key of Object.keys(CRITICAL_SELECTORS)) {
    const prev = prevResults[key];
    const curr = currResults[key];
    if (!prev || !curr) continue;

    if (prev.alive && !curr.alive) {
      console.log(`  🔴 ${key}: 正常 → 失效`);
      changed = true;
    } else if (!prev.alive && curr.alive) {
      console.log(`  🟢 ${key}: 失效 → 恢复`);
      changed = true;
    }
  }

  // 2. Class 名变化
  const prevClasses = new Set(prevData.allClasses || []);
  const currClasses = new Set(data.allClasses || []);

  const added = [...currClasses].filter((c) => !prevClasses.has(c));
  const removed = [...prevClasses].filter((c) => !currClasses.has(c));

  if (added.length > 0) {
    console.log(`\n  ➕ 新增 class (${added.length}):`);
    for (const c of added.slice(0, 20)) console.log(`     + ${c}`);
    if (added.length > 20) console.log(`     ... 及 ${added.length - 20} 个更多`);
    changed = true;
  }

  if (removed.length > 0) {
    console.log(`\n  ➖ 移除 class (${removed.length}):`);
    for (const c of removed.slice(0, 20)) console.log(`     - ${c}`);
    if (removed.length > 20) console.log(`     ... 及 ${removed.length - 20} 个更多`);
    changed = true;
  }

  if (!changed) {
    console.log('  ✅ 无变化，DOM 结构与上次一致');
  } else {
    console.log('\n  ⚠️  检测到变化！建议检查 recommend.ts 中的 selector 是否需要更新');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  主流程
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. 连接已运行的浏览器
  console.log(`🔌 正在连接 boss-cli 浏览器 (端口 ${opts.port})...`);

  const wsEndpoint = await getWsEndpoint(opts.port);
  if (!wsEndpoint) {
    console.error('❌ 无法连接浏览器！请确保 boss-cli 已启动。');
    console.error(`   检查: http://127.0.0.1:${opts.port}/json/version`);
    process.exit(1);
  }
  console.log('✅ 浏览器已连接');

  // 2. 找到推荐页的 target
  const targets = await getPageTargets(opts.port);
  const zhipinTargets = targets.filter(
    (t) => t.type === 'page' && t.url && t.url.includes('zhipin.com'),
  );

  if (zhipinTargets.length === 0) {
    console.error('❌ 未找到 zhipin.com 页面！请先打开 Boss 推荐页。');
    process.exit(1);
  }

  // 优先选推荐页，否则选第一个 zhipin 页面
  const recommendTarget = zhipinTargets.find((t) => t.url.includes('recommend')) || zhipinTargets[0];
  console.log(`📄 目标页面: ${recommendTarget.url.slice(0, 80)}...`);

  // 3. 通过 CDP WebSocket 连接到具体页面
  const pageWs = recommendTarget.webSocketDebuggerUrl;
  if (!pageWs) {
    console.error('❌ 页面无 WebSocket 调试地址');
    process.exit(1);
  }

  let cdp;
  try {
    cdp = await createCdpConnection(pageWs);
  } catch (e) {
    console.error(`❌ CDP 连接失败: ${e.message}`);
    process.exit(1);
  }

  // 4. 在页面中执行只读检测
  console.log('🔍 执行 DOM selector 检测...\n');

  let result;
  try {
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: buildCheckExpression(CRITICAL_SELECTORS),
      returnByValue: true,
      awaitPromise: false,
    });

    if (evalResult.exceptionDetails) {
      throw new Error(evalResult.exceptionDetails.text || 'evaluate failed');
    }
    result = evalResult.result.value;
  } catch (e) {
    // 如果主页面执行失败，可能需要在 iframe 内执行
    // 尝试获取 iframe 的 execution context
    console.log('ℹ️  主页面未找到元素，尝试查找推荐 iframe...');

    try {
      // 获取所有 frame
      const frameTree = await cdp.send('Page.getFrameTree', {});
      const frames = [];
      function collectFrames(node) {
        frames.push(node.frame);
        if (node.childFrames) node.childFrames.forEach(collectFrames);
      }
      collectFrames(frameTree.frameTree);

      const recFrame = frames.find(
        (f) => f.url && (f.url.includes('recommend') || f.url.includes('zhipin.com/web/boss')),
      );

      if (recFrame) {
        console.log(`  📎 找到 iframe: ${recFrame.url.slice(0, 60)}...`);
        // 需要获取该 frame 的 execution context
        const contexts = await cdp.send('Runtime.evaluate', {
          expression: buildCheckExpression(CRITICAL_SELECTORS),
          returnByValue: true,
          // 对于 iframe 需要指定 contextId，这里尝试直接在主页面用跨 frame 逻辑
        });
        result = contexts.result?.value;
      }
    } catch (frameErr) {
      console.error(`❌ 检测执行失败: ${e.message}`);
      cdp.close();
      process.exit(1);
    }

    if (!result) {
      console.error(`❌ 检测执行失败: ${e.message}`);
      cdp.close();
      process.exit(1);
    }
  }

  cdp.close();

  // 5. 输出报告
  console.log(formatHealthReport(result));

  // 6. 保存快照（如果指定）
  if (opts.snapshot) {
    await saveSnapshot(result);
  }

  // 7. 对比差异（如果指定）
  if (opts.diff) {
    await diffWithPrevious(result);
  }

  // 退出码
  const brokenCount = Object.values(result.selectorResults)
    .filter((v) => !v.alive).length;
  if (brokenCount > 0 && result.cardCount > 0) {
    process.exit(2); // 有卡片但 selector 失效 = 真正的问题
  }
}

main().catch((e) => {
  console.error(`\n💥 未预期错误: ${e.message}`);
  process.exit(1);
});
