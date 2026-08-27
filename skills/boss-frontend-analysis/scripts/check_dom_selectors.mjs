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
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --page chat
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --snapshot
 *   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --diff
 *
 * 前提：boss-cli 浏览器已打开对应页面（推荐页 / 沟通页）。
 * 必须在跑 boss-mcp 的那台机器上执行——它连的是 127.0.0.1 的调试端口。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  配置：与源码中硬编码的 selector 保持一致
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 按页面分组。
 *
 * 分组的原因：推荐页和沟通页的 selector 互不存在，混在一张清单里检测，
 * 站在推荐页上看聊天列表那批必然全红，报告里 10 个「失效」全是噪声——
 * 上一版就是这样，真失效反而被淹掉。现在只对「当前页面适用」的那组判定死活。
 */
const SELECTOR_GROUPS = {
  // src/toolset/recommend.ts
  recommend: {
    label: '推荐页（boss_recommend / boss_greet）',
    detect: '.candidate-card-wrap, .card-list .card-item, .geek-list .geek-card',
    // 这些元素本身就是「按状态才出现」的，缺失不代表 selector 失效，不计入判定
    conditional: ['hasViewed', 'emptyWorkExp'],
    selectors: {
      cardRoot: '.candidate-card-wrap, .card-list .card-item, .geek-list .geek-card',
      cardInner: '.card-inner',
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
      greetBtn: '.button-chat-wrap .btn.btn-greet',
      buttonArea: '.button-chat-wrap',
      chatHistory: '.tooltip-wrap.chat-history .icon-chat-history',
      hasViewed: '.candidate-card-wrap.has-viewed',
      jobSelector: '.job-selecter-wrap .ui-dropmenu-label',
    },
  },
  // src/toolset/list.ts + src/toolset/chat.ts
  chat: {
    label: '沟通页（boss_list_candidates / boss_open_chat）',
    detect: '.geek-item-wrap, .geek-item',
    // 「沟通记录」弹窗只在点开之后才存在；未读角标只有未读会话才有
    conditional: ['historyPanel', 'historyRecord', 'unreadBadge'],
    selectors: {
      rowWrap: '.geek-item-wrap',
      row: '.geek-item',
      rowSelected: '.geek-item.selected',
      rowName: '.geek-name',
      sourceJob: '.source-job',
      pushText: '.push-text',
      rowTime: '.time',
      unreadBadge: '.badge-count',
      detailContainer: '.base-info-single-container',
      detailName: '.name-box',
      detailFacts: '.base-info-single-detial > div',
      activeTime: '.high-light-orange.active-time span',
      historyPanel: '.chat-history-process',
      historyRecord: '.chat-history-process .record',
      historyEntry: '.chat-tooltip-custom',
    },
  },
};

// 快照输出目录
const SNAPSHOT_DIR = path.join('docs', 'research', 'dom-snapshots');

/** 快照里保存的卡片 outerHTML 上限，够看结构又不至于把快照撑爆。 */
const HTML_SAMPLE_LIMIT = 6000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  参数解析
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseArgs(argv) {
  const opts = { port: 53470, snapshot: false, diff: false, page: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (argv[i] === '--page' && argv[i + 1]) {
      opts.page = String(argv[++i]);
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
  --port <number>            boss-cli 浏览器调试端口 (默认 53470)
  --page recommend|chat|auto 选哪个已打开的页面来查 (默认 auto：优先推荐页)
  --snapshot                 保存当前 DOM 结构快照（含卡片 outerHTML 样本）
  --diff                     与最近一次快照对比差异
  --help                     显示帮助

安全说明:
  此脚本连接已打开的 boss-cli 浏览器实例，仅通过 CDP 在页面内
  执行 querySelectorAll 只读操作。不发送任何网络请求，不修改 DOM，
  不触发任何用户事件。对 Boss 后端完全不可见。
`);
      process.exit(0);
    }
  }
  if (!['auto', 'recommend', 'chat'].includes(opts.page)) {
    console.error(`❌ --page 只能是 recommend / chat / auto，收到：${opts.page}`);
    process.exit(1);
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
  } catch {
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
  // 只用 Node 内置 WebSocket（Node >= 22 默认可用）。
  // 原先写成 `globalThis.WebSocket ?? (await import('ws')).default`：`ws` 既不是本仓库依赖，
  // 而且 `await` 出现在非 async 的 Promise executor 里 —— 整个文件在解析阶段就 SyntaxError，
  // 这个脚本从来没能跑起来过。缺失时直接报错，不做二次回退。
  const WebSocketClass = globalThis.WebSocket;
  if (typeof WebSocketClass !== 'function') {
    throw new Error(
      `当前 Node（${process.version}）没有内置 WebSocket，无法连接 CDP。请用 Node >= 22 运行本脚本。`,
    );
  }
  return new Promise((resolve, reject) => {
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
 * 注入页面执行的检测表达式（字符串形式，通过 Runtime.evaluate 发送）。
 * 绝对只读：querySelectorAll + textContent + getAttribute + outerHTML。
 */
function buildCheckExpression(groups, htmlLimit) {
  return `(function() {
    'use strict';
    var groups = ${JSON.stringify(groups)};
    var htmlLimit = ${htmlLimit};

    function norm(v) { return (v == null ? '' : String(v)).replace(/\\s+/g, ' ').trim(); }

    // 推荐列表挂在同源 iframe（recommendFrame）里，聊天列表在主文档。
    // 两处都要能查到，所以先决定在哪个 document 上跑。
    var doc = document;
    var docSource = 'main';
    var recFrame = document.querySelector('iframe[src*="recommend"], iframe[name*="recommend"]');
    if (recFrame) {
      var inner = null;
      try { inner = recFrame.contentDocument; } catch (e) { inner = null; }
      if (inner && inner.querySelector(groups.recommend.detect)) {
        doc = inner;
        docSource = 'recommendFrame';
      }
    }

    var out = {
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      docSource: docSource,
      groups: {},
    };

    for (var name in groups) {
      var g = groups[name];
      var applicable = !!doc.querySelector(g.detect);
      var conditional = g.conditional || [];
      var results = {};
      for (var key in g.selectors) {
        var sel = g.selectors[key];
        var isConditional = conditional.indexOf(key) !== -1;
        try {
          var els = doc.querySelectorAll(sel);
          results[key] = {
            selector: sel,
            found: els.length,
            alive: els.length > 0,
            conditional: isConditional,
            sampleText: els.length > 0 ? norm(els[0].textContent).slice(0, 50) : null,
          };
        } catch (e) {
          results[key] = {
            selector: sel,
            found: 0,
            alive: false,
            conditional: isConditional,
            error: e.message,
          };
        }
      }
      out.groups[name] = {
        label: g.label,
        applicable: applicable,
        selectorResults: results,
      };
    }

    // ── 逐卡「打招呼」按钮统计 ──────────────────────────────
    //
    // 为什么不能只看 greetBtn 的全局数量：只要有一张卡带按钮，全局计数就 > 0，
    // 整项判定为「正常」，而「某个候选人这张卡没有按钮」正好被盖掉——
    // 线上那条「候选人 X 缺少打招呼按钮」就属于这种情况，全局计数完全看不出来。
    var recGroup = groups.recommend;
    var cards = doc.querySelectorAll(recGroup.detect);
    var perCard = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var nm =
        norm((card.querySelector('.name-wrap .name') || {}).textContent) ||
        norm((card.querySelector('.name') || {}).textContent);
      var area = card.querySelector('.button-chat-wrap');
      var buttons = [];
      if (area) {
        var btnEls = area.querySelectorAll('.btn, button, span[class*="btn"]');
        for (var b = 0; b < btnEls.length; b++) {
          buttons.push({
            classes: btnEls[b].className || '',
            text: norm(btnEls[b].textContent).slice(0, 20),
            disabledAttr: btnEls[b].getAttribute('disabled') !== null,
          });
        }
      }
      perCard.push({
        index: i + 1,
        name: nm,
        hasButtonArea: !!area,
        hasGreetBtn: !!card.querySelector('.button-chat-wrap .btn.btn-greet'),
        buttons: buttons,
      });
    }
    out.cardCount = cards.length;
    out.perCardGreet = perCard;

    // ── 结构与 class 采集（供 diff）──────────────────────────
    var allClasses = [];
    var htmlSample = null;
    if (cards.length > 0) {
      var classSet = {};
      var allEls = cards[0].querySelectorAll('*');
      for (var k = 0; k < allEls.length; k++) {
        var cl = allEls[k].classList;
        for (var j = 0; j < cl.length; j++) classSet[cl[j]] = true;
      }
      allClasses = Object.keys(classSet).sort();
      htmlSample = cards[0].outerHTML.slice(0, htmlLimit);
    }

    // 没有按钮的那张卡最值得留证：把它的 HTML 也带上，便于判断是漂移还是业务状态
    var missing = null;
    for (var m = 0; m < perCard.length; m++) {
      if (!perCard[m].hasGreetBtn) {
        missing = {
          name: perCard[m].name,
          html: cards[m].outerHTML.slice(0, htmlLimit),
        };
        break;
      }
    }

    // 聊天列表：也留一行的 HTML，供 #未找到候选人 这类问题定位
    var rowSample = null;
    var firstRow = doc.querySelector('.geek-item-wrap');
    if (firstRow) rowSample = firstRow.outerHTML.slice(0, htmlLimit);

    out.allClasses = allClasses;
    out.htmlSamples = { firstCard: htmlSample, cardMissingGreet: missing, firstChatRow: rowSample };

    return out;
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
  lines.push(`📦 取样文档: ${data.docSource === 'recommendFrame' ? 'recommendFrame（iframe 内）' : '主文档'}`);
  lines.push(`🃏 推荐卡片: ${data.cardCount}`);
  lines.push('');

  for (const [name, group] of Object.entries(data.groups)) {
    const results = group.selectorResults;
    const total = Object.keys(results).length;
    const alive = Object.entries(results).filter(([, v]) => v.alive);
    // 「按状态才出现」的 selector 缺失不算失效，否则每次检测都挂着一排假红
    const broken = Object.entries(results).filter(([, v]) => !v.alive && !v.conditional);
    const absentConditional = Object.entries(results).filter(([, v]) => !v.alive && v.conditional);

    if (!group.applicable) {
      lines.push(`━━━ ⏭️  ${group.label} — 当前页面不是这个页面，跳过判定 ━━━`);
      lines.push(`     （命中 ${alive.length}/${total} 个 selector，仅作参考，不计入退出码）`);
      lines.push('');
      continue;
    }

    lines.push(`━━━ ${broken.length === 0 ? '✅' : '❌'} ${group.label} — ${alive.length}/${total} 正常 ━━━`);
    for (const [key, val] of alive) {
      const sample = val.sampleText ? ` → "${val.sampleText}"` : '';
      lines.push(`  ✅ ${key.padEnd(18)} [${val.found}个]${sample}`);
    }
    for (const [key, val] of broken) {
      const reason = val.error ? ` (${val.error})` : '';
      lines.push(`  ❌ ${key.padEnd(18)} ${val.selector}${reason}`);
    }
    for (const [key, val] of absentConditional) {
      lines.push(`  ℹ️ ${key.padEnd(18)} ${val.selector}（按状态才出现，本次未出现，不计入判定）`);
    }
    if (broken.length > 0) {
      lines.push('');
      lines.push('  ⚠️  上述 selector 在当前页面未找到匹配元素，可能是 Boss 改了 class / 结构。');
      lines.push('     用 --snapshot 保存结构后，对比 classes.txt 与 card.html 定位新名字。');
    }
    lines.push('');
  }

  // 逐卡打招呼按钮
  const perCard = data.perCardGreet || [];
  if (perCard.length > 0) {
    const without = perCard.filter((c) => !c.hasGreetBtn);
    lines.push(`━━━ 「打招呼」按钮逐卡统计：${perCard.length - without.length}/${perCard.length} 张卡可打招呼 ━━━`);
    if (without.length === 0) {
      lines.push('  ✅ 每张卡都有 .button-chat-wrap .btn.btn-greet');
    } else {
      for (const c of without) {
        const detail = c.hasButtonArea
          ? c.buttons.length > 0
            ? c.buttons.map((b) => `"${b.text}"[${b.classes}]`).join(' / ')
            : '按钮区存在但为空'
          : '连 .button-chat-wrap 都没有';
        lines.push(`  ⚠️  #${c.index} ${c.name || '(无名)'} → ${detail}`);
      }
      lines.push('');
      lines.push('  判读方式：按钮区里是「继续沟通」这类其它文案 = 业务状态，boss_greet 报错属实；');
      lines.push('           按钮区为空或整块缺失 = 结构可能变了，需要核对 recommend.ts 的 selector。');
    }
    lines.push('');
  }

  if (data.cardCount === 0 && data.groups.recommend?.applicable === false) {
    lines.push('ℹ️  当前页面没有推荐卡片。要查推荐页的 selector，请先让浏览器停在推荐页。');
    lines.push('');
  }

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

  await writeFile(path.join(dir, 'snapshot.json'), JSON.stringify(data, null, 2), 'utf8');
  await writeFile(path.join(dir, 'classes.txt'), (data.allClasses || []).join('\n') + '\n', 'utf8');
  await writeFile(path.join(dir, 'report.txt'), formatHealthReport(data), 'utf8');

  const samples = data.htmlSamples || {};
  const written = ['snapshot.json', 'classes.txt', 'report.txt'];
  if (samples.firstCard) {
    await writeFile(path.join(dir, 'card.html'), samples.firstCard, 'utf8');
    written.push('card.html');
  }
  if (samples.cardMissingGreet) {
    await writeFile(
      path.join(dir, 'card-missing-greet.html'),
      `<!-- 候选人：${samples.cardMissingGreet.name} -->\n${samples.cardMissingGreet.html}`,
      'utf8',
    );
    written.push('card-missing-greet.html');
  }
  if (samples.firstChatRow) {
    await writeFile(path.join(dir, 'chat-row.html'), samples.firstChatRow, 'utf8');
    written.push('chat-row.html');
  }

  console.log(`\n📸 快照已保存到: ${dir}/`);
  for (const f of written) console.log(`   - ${f}`);
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

  let changed = false;

  for (const groupName of Object.keys(SELECTOR_GROUPS)) {
    const prevGroup = prevData.groups?.[groupName];
    const currGroup = data.groups?.[groupName];
    if (!prevGroup || !currGroup) continue;
    // 只在两次都适用时比较，否则「换了页面」会被误报成失效
    if (!prevGroup.applicable || !currGroup.applicable) continue;

    for (const key of Object.keys(SELECTOR_GROUPS[groupName].selectors)) {
      const prev = prevGroup.selectorResults?.[key];
      const curr = currGroup.selectorResults?.[key];
      if (!prev || !curr) continue;
      // 「按状态才出现」的项天然会来回翻，diff 里不报，否则每次都是噪声
      if (curr.conditional || prev.conditional) continue;
      if (prev.alive && !curr.alive) {
        console.log(`  🔴 ${groupName}.${key}: 正常 → 失效`);
        changed = true;
      } else if (!prev.alive && curr.alive) {
        console.log(`  🟢 ${groupName}.${key}: 失效 → 恢复`);
        changed = true;
      }
    }
  }

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
    console.log('\n  ⚠️  检测到变化！建议核对 recommend.ts / chat.ts 里的 selector');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  主流程
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 按 --page 意图挑一个已打开的 zhipin 标签；auto 时优先推荐页，其次沟通页。 */
function pickTarget(targets, want) {
  const pages = targets.filter((t) => t.type === 'page' && t.url && t.url.includes('zhipin.com'));
  if (pages.length === 0) return null;

  const byRecommend = pages.find((t) => t.url.includes('recommend'));
  const byChat = pages.find((t) => t.url.includes('/chat'));

  if (want === 'recommend') return byRecommend ?? null;
  if (want === 'chat') return byChat ?? null;
  return byRecommend ?? byChat ?? pages[0];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`🔌 正在连接 boss-cli 浏览器 (端口 ${opts.port})...`);

  const wsEndpoint = await getWsEndpoint(opts.port);
  if (!wsEndpoint) {
    console.error('❌ 无法连接浏览器！请确保 boss-cli 已启动。');
    console.error(`   检查: http://127.0.0.1:${opts.port}/json/version`);
    process.exit(1);
  }
  console.log('✅ 浏览器已连接');

  const targets = await getPageTargets(opts.port);
  const target = pickTarget(targets, opts.page);
  if (!target) {
    console.error(
      opts.page === 'auto'
        ? '❌ 未找到 zhipin.com 页面！请先在浏览器里打开推荐页或沟通页。'
        : `❌ 未找到 ${opts.page} 页面！请先在浏览器里打开它，或换 --page auto。`,
    );
    process.exit(1);
  }
  console.log(`📄 目标页面: ${target.url.slice(0, 100)}`);

  if (!target.webSocketDebuggerUrl) {
    console.error('❌ 页面无 WebSocket 调试地址');
    process.exit(1);
  }

  let cdp;
  try {
    cdp = await createCdpConnection(target.webSocketDebuggerUrl);
  } catch (e) {
    console.error(`❌ CDP 连接失败: ${e.message}`);
    process.exit(1);
  }

  console.log('🔍 执行 DOM selector 检测...\n');

  let result;
  try {
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: buildCheckExpression(SELECTOR_GROUPS, HTML_SAMPLE_LIMIT),
      returnByValue: true,
      awaitPromise: false,
    });
    if (evalResult.exceptionDetails) {
      throw new Error(evalResult.exceptionDetails.text || 'evaluate failed');
    }
    result = evalResult.result.value;
    if (!result) {
      throw new Error('检测表达式没有返回数据');
    }
  } catch (e) {
    // 不做「换个地方再试一次」的假恢复：失败原因要直接暴露。
    console.error(`❌ 检测执行失败: ${e.message}`);
    cdp.close();
    process.exit(1);
  }

  cdp.close();

  console.log(formatHealthReport(result));

  if (opts.snapshot) {
    await saveSnapshot(result);
  }
  if (opts.diff) {
    await diffWithPrevious(result);
  }

  // 退出码只看「当前页面适用」的那些组，避免站在推荐页上被聊天页 selector 判死
  let broken = 0;
  for (const group of Object.values(result.groups)) {
    if (!group.applicable) continue;
    broken += Object.values(group.selectorResults).filter((v) => !v.alive && !v.conditional).length;
  }
  if (broken > 0) {
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`\n💥 未预期错误: ${e.message}`);
  process.exit(1);
});
