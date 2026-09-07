/**
 * Boss 前端锚点看守（selector watch）—— 每日定时跑的检测 + 候选推导，带全链路日志。
 *
 * 与同目录 `check_dom_selectors.mjs` 的分工
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * `check_dom_selectors.mjs`：零风险、纯只读、**不导航**、手动跑。只看「当前恰好打开的那页」。
 * 本脚本：为无人值守设计，**会自己开一个新标签并导航**到要检查的页面，检查完关掉。
 *   —— 这是两者安全等级的唯一差别，必须写明，不要把本脚本的行为算进那份「零风险」承诺里。
 *
 * 为什么必须导航：定时任务无法假设某个页面正好开着。上一版靠「当前页面」判定，
 * 结果职位管理页从来没被检查过——而这次真正坏掉的恰好就是它。
 *
 * 三个阶段，对应三种退出语义
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   --baseline  采集黄金基线（要求当前代码是好的，采集时机很重要）
 *   --check     断言锚点；失效的锚点自动枚举候选并与基线比对（默认动作）
 *   --apply     仅对「白名单允许 + 纯读调用点 + 候选唯一 + 基线 100% 复现」的锚点改常量
 *
 * 日志（可持续追踪，字段固定，便于后续开发）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   ~/.boss-cli/logs/selector-watch.jsonl        每锚点一条，记录 triggered / acquired / updated
 *   ~/.boss-cli/logs/selector-watch/<run>.txt    人读报告
 *
 * 用法：
 *   node skills/boss-frontend-analysis/scripts/selector_watch.mjs --baseline
 *   node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check
 *   node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check --selftest
 *   node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check --apply
 *
 * 必须在跑 boss-mcp 的那台机器上执行（连 127.0.0.1 的调试端口）。
 */

import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  常量
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_CDP_PORT = 53470;

/**
 * CDP 单条命令的超时。
 *
 * puppeteer 默认 180s，对定时任务太长——一次挂死会把整轮拖到凌晨结束。实测推荐页的
 * `Runtime.evaluate` 会偶发超时（同一份代码紧接着重跑就正常），所以这里设短一些，
 * 让它快速失败并走下面的重试，而不是长时间僵着。
 */
const CDP_PROTOCOL_TIMEOUT_MS = 45_000;

/**
 * 提取阶段的重试次数。
 *
 * 只对「CDP 层瞬时故障」重试，且重试次数会记进日志。这不是掩盖失败：
 * evaluate 超时属于环境条件，不是锚点判定结果，混为一谈会让报告把浏览器抖动
 * 说成前端改版。把它单独记下来，偶发率高不高在数据里看得见。
 */
const EXTRACT_MAX_ATTEMPTS = 2;

/** 页面渲染等待上限。iframe 里的列表实测有时 8s 还没出来，固定等待会偶发拿到 0 行，所以轮询。 */
const PAGE_READY_TIMEOUT_MS = 40_000;
const PAGE_READY_POLL_MS = 1_500;

/**
 * 「服务是否正忙」的判定窗口。
 *
 * 实测踩过的坑：同一个 Chrome 上同时有两个 CDP 客户端反复开关标签页，会把 boss-mcp
 * 进程持有的那条连接搞坏，之后每次工具调用都在十几毫秒内以 `Network.enable timed out`
 * 失败，且不自愈、只能重启服务。所以看守必须避开真实调用——审计日志最近有写入就跳过本轮。
 */
const SERVER_BUSY_WINDOW_MS = 10 * 60 * 1000;

const LOG_DIR = path.join(os.homedir(), '.boss-cli', 'logs');
const JSONL_PATH = path.join(LOG_DIR, 'selector-watch.jsonl');
const REPORT_DIR = path.join(LOG_DIR, 'selector-watch');
const AUDIT_LOG = path.join(LOG_DIR, 'mcp-audit.log');
const BASELINE_DIR = path.join('docs', 'research', 'selector-watch', 'baseline');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  锚点注册表
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 每个锚点必须声明四件事，缺一不可：
 *
 *   kind    —— 拿什么判定「新候选是对的」
 *               structural-oracle：页面自带计数可交叉校验（最强）
 *               value-baseline  ：靠复现基线里记录的具体值证明等价
 *               shape-only      ：只能校验形状（纯数字/非空），够检测不够自动修
 *   usage   —— 调用点是纯读还是也用于点击/定位身份
 *               这一项**必须按实际调用点审计填写，不能按文件或函数名想当然**。
 *               例：`JOB_ROW_SELECTOR` 同时被 readJobsFromFrame（读）和
 *               clickEditForJob（点）使用，所以它是 read+click，不是 read。
 *   autofix —— 是否允许自动改。usage 含 click 的一律 false：
 *               读错了产出可疑还能事后发现，点错了是不可逆动作。
 *   scope   —— page（全文档唯一）还是 row（每行一个，逐行提取）
 *
 * constName / source 用于 --apply 定位要改的常量；没有 constName 的锚点说明它在源码里
 * 还是内联字面量，脚本无法安全落笔（改 evaluate 字符串内部等于对源码做正则替换），
 * 只能报告，不能自动改。
 */
const REGISTRY = {
  jobList: {
    label: '职位管理列表（boss_list_positions / boss_get_jd 前置）',
    source: 'src/toolset/jd.ts',
    url: 'https://www.zhipin.com/web/chat/job/list',
    /** 列表在这个同源 iframe 里，不在主文档 */
    framePattern: '/web/frame/job_v2/list',
    rowAnchor: 'jobRow',
    /** 页面自带计数，作为行数的独立 oracle */
    pageCount: { selector: '.total-num', pattern: '共\\s*(\\d+)\\s*个职位' },
    anchors: {
      jobRow: {
        selector: 'li.job-item-container',
        constName: 'JOB_ROW_SELECTOR',
        kind: 'structural-oracle',
        usage: 'read+click',
        autofix: false,
        scope: 'page',
      },
      jobTitle: {
        selector: '.job-title .job-name',
        constName: 'JOB_TITLE_SELECTOR',
        kind: 'value-baseline',
        // clickEditForJob 按标题文本定位要点的那一行，所以标题也在点击路径上
        usage: 'read+click',
        autofix: false,
        scope: 'row',
        entityKey: true,
      },
      jobLabel: {
        selector: '.job-title .base-label',
        constName: 'JOB_LABEL_SELECTOR',
        kind: 'value-baseline',
        usage: 'read',
        autofix: true,
        scope: 'row',
      },
      jobStatus: {
        selector: '.job-status-wrapper .status-box',
        kind: 'value-baseline',
        usage: 'read',
        autofix: true,
        scope: 'row',
      },
      jobMeta: {
        selector: '.job-main-info-wrapper .info-labels span',
        kind: 'value-baseline',
        usage: 'read',
        autofix: true,
        scope: 'row',
        multi: true,
      },
      jobNums: {
        // 看过我/沟通过/感兴趣 三个计数每天都在变，值不能进基线，只能校验形状
        selector: '.job-about-num-wrapper .inner-box .num',
        kind: 'shape-only',
        usage: 'read',
        autofix: false,
        scope: 'row',
        multi: true,
        shape: 'digits',
        expectPerRow: 3,
      },
      operateBtn: {
        selector: '.operation-container .operate-btn',
        constName: 'JOB_OPERATE_BTN_SELECTOR',
        kind: 'value-baseline',
        usage: 'click',
        autofix: false,
        scope: 'row',
        multi: true,
      },
    },
  },

  recommend: {
    label: '推荐页（boss_recommend / boss_greet）',
    source: 'src/toolset/recommend.ts',
    url: 'https://www.zhipin.com/web/chat/recommend',
    framePattern: '/web/frame/recommend',
    // 行容器必须是卡片根 `.candidate-card-wrap`，不能用身份锚点 `.card-inner[data-geekid]`：
    // 按钮区 `.button-chat-wrap` 是 card-inner 的**兄弟**节点而不是子节点，
    // 用 card-inner 当行作用域会让 greetBtn 恒为 0（首次采基线时就踩到了）。
    rowAnchor: 'cardWrap',
    /**
     * 推荐页没有可用的值基线：候选人每次加载都换一批，昨天记下的姓名今天根本不在页面上。
     * 所以这一页只做结构不变量断言（卡片数 > 0、每张卡都能取到 geekId），
     * 失效时只报告、不推候选——这是这套机制的真实边界，不是偷懒。
     */
    structuralOnly: true,
    anchors: {
      cardAnchor: {
        selector: '.card-inner[data-geekid]',
        kind: 'structural-oracle',
        usage: 'read+click',
        autofix: false,
        scope: 'page',
      },
      cardWrap: {
        selector: '.candidate-card-wrap',
        kind: 'structural-oracle',
        usage: 'read+click',
        autofix: false,
        scope: 'page',
      },
      greetBtn: {
        selector: '.button-chat-wrap .btn.btn-greet',
        kind: 'shape-only',
        usage: 'click',
        autofix: false,
        scope: 'row',
        // 「继续沟通」等业务状态下本来就没有打招呼按钮，缺失不等于选择器失效
        conditional: true,
      },
    },
  },
};

/**
 * --selftest 用：把锚点换成**今天已确认失效**的旧选择器，验证「触发→枚举→比对→决策」整条链。
 * 用真实历史故障做自测，比造假数据可信：这些旧值就是 Boss 改版前源码里写的东西。
 *
 *   row   —— 打断行容器与标题（今天真实故障的形态）
 *   field —— 只打断行内字段（行容器仍然活着），用来考察低熵字段能不能推出唯一候选
 */
const SELFTEST_PROFILES = {
  row: {
    jobList: {
      jobRow: '.job-jobInfo-warp',
      jobTitle: '.job-title a',
    },
  },
  field: {
    jobList: {
      jobLabel: '.job-title .label-common',
      jobStatus: '.job-status-wrapper .status-text-dead',
      jobMeta: '.job-main-info-wrapper .info-labels em',
    },
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  参数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_CDP_PORT,
    mode: 'check',
    apply: false,
    selftest: null,
    pages: null,
    ignoreBusy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (a === '--baseline') opts.mode = 'baseline';
    else if (a === '--check') opts.mode = 'check';
    else if (a === '--apply') opts.apply = true;
    else if (a === '--selftest') {
      // 可跟 row / field 指定自测剖面，不跟就默认 row
      const next = argv[i + 1];
      opts.selftest = next && !next.startsWith('--') ? String(argv[++i]) : 'row';
    }
    else if (a === '--ignore-busy') opts.ignoreBusy = true;
    else if (a === '--pages' && argv[i + 1]) opts.pages = String(argv[++i]).split(',');
    else if (a === '--help' || a === '-h') {
      console.log(`
Boss 前端锚点看守

  --baseline        采集黄金基线（务必在代码已验证可用时采）
  --check           断言锚点 + 失效时枚举候选（默认）
  --apply           允许自动改常量（仅白名单 + 纯读 + 候选唯一 + 基线全复现）
  --selftest [row|field]  用已知失效的旧选择器验证整条链路（默认 row）
  --pages a,b       只跑指定页面（默认全部）：${Object.keys(REGISTRY).join(',')}
  --ignore-busy     忽略「服务正忙」保护（调试用）
  --port <n>        调试端口，默认 ${DEFAULT_CDP_PORT}

退出码：0 全部正常 / 2 有锚点失效 / 3 本轮跳过（忙或前置不满足）/ 1 脚本自身出错
`);
      process.exit(0);
    }
  }
  if (opts.pages) {
    const bad = opts.pages.filter((p) => !REGISTRY[p]);
    if (bad.length) {
      console.error(`❌ 未知页面：${bad.join(',')}`);
      process.exit(1);
    }
  }
  return opts;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  工具
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function nowIso() {
  return new Date().toISOString();
}

function runIdOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 服务最近是否有真实调用。
 * 用审计日志的最后写入时间判断，而不是 /health 的 sessions 数——空闲会话也会计数，
 * 那个数字长期是 3~5，据此判忙会导致看守永远不跑。
 */
async function serverRecentlyBusy() {
  try {
    const st = await stat(AUDIT_LOG);
    const idleMs = Date.now() - st.mtimeMs;
    return { busy: idleMs < SERVER_BUSY_WINDOW_MS, idleMs, lastWrite: st.mtime.toISOString() };
  } catch {
    return { busy: false, idleMs: null, lastWrite: null };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  浏览器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 附加前先体检。
 *
 * 实测：渲染进程挂死时，浏览器级 HTTP 端点（/json/version、/json/list）照样正常响应，
 * 但对 page target 发 `Network.enable` 会一直不返回——puppeteer 连 attach 都做不到，
 * 报出来是个看不出根因的 60s 超时。所以先用 HTTP 端点确认浏览器活着，
 * 再把 attach 失败单独归类成 browser-unhealthy，而不是混进「锚点失效」里。
 */
async function preflight(port) {
  const base = `http://127.0.0.1:${port}`;
  const out = { ok: false, browser: null, pages: [], reason: null };
  try {
    const v = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(8000) });
    out.browser = (await v.json())['Browser'] ?? null;
  } catch (e) {
    out.reason = `调试端口无响应：${e.message}`;
    return out;
  }
  try {
    const l = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
    const targets = await l.json();
    out.pages = targets.filter((t) => t.type === 'page').map((t) => t.url);
  } catch (e) {
    out.reason = `/json/list 失败：${e.message}`;
    return out;
  }
  out.ok = true;
  return out;
}

/** 登录态判定：URL 落到登录页就说明没登录。分不清「没登录」和「选择器坏了」的监控会天天误报。 */
function looksLoggedOut(url) {
  return /\/web\/user\/?\?|ka=header-login|ka=bticket/.test(url);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  页面内提取脚本（按 AGENTS.md：evaluate 一律传字符串，不传回调）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 按注册表提取每个锚点的命中数与取值。 */
function buildExtractExpression(pageDef, anchors) {
  return `(() => {
    const norm = (v) => (v == null ? '' : String(v)).replace(/\\s+/g, ' ').trim();
    const pageDef = ${JSON.stringify({ rowAnchor: pageDef.rowAnchor, pageCount: pageDef.pageCount ?? null })};
    const anchors = ${JSON.stringify(anchors)};

    const out = { url: location.href, ts: new Date().toISOString(), anchors: {}, pageCount: null };

    if (pageDef.pageCount) {
      const el = document.querySelector(pageDef.pageCount.selector);
      const text = norm(el ? el.textContent : '');
      out.pageCountText = text;
      const m = text.match(new RegExp(pageDef.pageCount.pattern));
      out.pageCount = m ? Number(m[1]) : null;
    }

    const rowDef = anchors[pageDef.rowAnchor];
    const rows = rowDef ? Array.from(document.querySelectorAll(rowDef.selector)) : [];

    for (const key of Object.keys(anchors)) {
      const a = anchors[key];
      const rec = { selector: a.selector, scope: a.scope, found: 0, values: [], perRow: null, error: null };
      try {
        if (a.scope === 'row') {
          rec.perRow = [];
          for (const row of rows) {
            const els = Array.from(row.querySelectorAll(a.selector));
            rec.found += els.length;
            const vals = els.map((e) => norm(e.textContent)).filter((s) => s.length > 0);
            rec.perRow.push(vals);
            if (a.multi) { for (const v of vals) rec.values.push(v); }
            else if (vals.length > 0) { rec.values.push(vals[0]); }
          }
        } else {
          const els = Array.from(document.querySelectorAll(a.selector));
          rec.found = els.length;
          rec.values = els.slice(0, 60).map((e) => norm(e.textContent));
        }
      } catch (e) {
        rec.error = e.message;
      }
      out.anchors[key] = rec;
    }

    out.rowCount = rows.length;
    return out;
  })()`;
}

/**
 * 字段候选枚举 + 基线比对。
 *
 * 判定不是「像不像」，而是「能否精确复现基线里记录的那批值」。这一步把没有天然 oracle
 * 的值字段转成可自动判定的：13 个职位标题一字不差地复现出来，才算证明等价。
 */
function buildFieldCandidateSnippet() {
  return `
    const fieldCandidates = (spec) => {
      const norm = (v) => (v == null ? '' : String(v)).replace(/\\s+/g, ' ').trim();
      const want = new Set(spec.wantValues);
      const rowSel = spec.rowSelector;
      const scope = spec.scope;

      // 候选生成方式：从「文本命中基线」的元素反推，而不是穷举全页 class。
      // 反推保证每个候选至少解释了一个已知正确值，候选集小且都带证据。
      const selectorsOf = (el) => {
        const out = [];
        const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
        const tag = el.tagName.toLowerCase();
        for (const c of cls) { out.push('.' + c); out.push(tag + '.' + c); }
        if (cls.length > 1) out.push('.' + cls.join('.'));
        const p = el.parentElement;
        if (p) {
          const pcls = (p.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
          for (const pc of pcls) { for (const c of cls) out.push('.' + pc + ' .' + c); }
        }
        return out;
      };

      let rows;
      if (scope === 'row') {
        try { rows = Array.from(document.querySelectorAll(rowSel)); } catch (e) { rows = []; }
      } else {
        rows = [document];
      }
      if (rows.length === 0) return { rows: 0, candidates: [] };

      // 用「元素自身的直接文本」定位，而不是「叶子元素的 textContent」：
      // 有子元素但自己带文字的节点（如状态格）用叶子过滤会被漏掉。
      const cand = new Set();
      for (const root of rows) {
        for (const el of root.querySelectorAll('*')) {
          if (!want.has(ownText(el))) continue;
          for (const s of selectorsOf(el)) cand.add(s);
        }
      }

      // 判定用**多重集相等**，不是集合相等。
      // 首版写的是 produced.length === want.size，拿「唯一值个数」比对「元素个数」：
      // 职位标签 13 个全是「竞」，唯一值只有 1 个，13 !== 1，于是永远判不出 exact。
      // 低熵字段本来就该靠「个数与内容都对得上」来证明，不是靠去重后的集合。
      const wantSorted = spec.wantValues.slice().sort().join('\\u0000');

      const results = [];
      for (const sel of cand) {
        const els = [];
        try {
          for (const root of rows) {
            for (const e of root.querySelectorAll(sel)) els.push(e);
          }
        } catch (e) { continue; }
        const produced = els.map((e) => norm(e.textContent)).filter((t) => t.length > 0);
        const producedSet = new Set(produced);
        let hit = 0;
        for (const w of want) { if (producedSet.has(w)) hit++; }
        const extra = produced.filter((p) => !want.has(p)).length;
        results.push({
          selector: sel,
          els: els,
          found: produced.length,
          matched: hit,
          wanted: want.size,
          extra: extra,
          exact: produced.slice().sort().join('\\u0000') === wantSorted,
        });
      }

      // 同一批元素的不同写法（.base-label / div.base-label / .job-labels .base-label）
      // 是同一个答案的不同拼法，不构成语义歧义，归并成一条并把别名记下来。
      // 只有指向**不同元素集**的候选才是真歧义，那种情况才需要交给人。
      const merged = [];
      for (const c of results) {
        const twin = merged.find(
          (m) => m.els.length === c.els.length && m.els.every((x, i) => x === c.els[i]),
        );
        if (!twin) {
          merged.push({ ...c, aliases: [] });
          continue;
        }
        const twinIsTagged = /^[a-z]+\\./.test(twin.selector);
        const candIsTagged = /^[a-z]+\\./.test(c.selector);
        if (candIsTagged && !twinIsTagged) {
          twin.aliases.push(twin.selector);
          twin.selector = c.selector;
        } else {
          twin.aliases.push(c.selector);
        }
      }

      merged.sort((a, b) =>
        (Number(b.exact) - Number(a.exact)) || (b.matched - a.matched) ||
        (a.extra - b.extra) || (a.selector.length - b.selector.length));
      return {
        rows: rows.length,
        candidates: merged.slice(0, 25).map((c) => ({
          selector: c.selector,
          aliases: c.aliases,
          found: c.found,
          matched: c.matched,
          wanted: c.wanted,
          extra: c.extra,
          exact: c.exact,
        })),
      };
    };
  `;
}

/**
 * 把所有失效锚点的候选枚举合并成**一次** evaluate。
 *
 * 首版是一个锚点一次 evaluate，自测时第二个锚点就开始报
 * `Attempted to use detached Frame`——目标页的 iframe 在检测过程中被重挂了。
 * 逐次进入页面既慢又脆；合并成一次之后只需要一个存活的 frame 窗口。
 */
function buildEnumerateExpression(jobs) {
  return `(() => {
    ${buildOwnTextSnippet()}
    ${buildRowCandidateSnippet()}
    ${buildFieldCandidateSnippet()}
    const jobs = ${JSON.stringify(jobs)};
    const out = {};
    for (const job of jobs) {
      try {
        out[job.anchor] = job.type === 'row'
          ? { candidates: rowCandidates(job.spec) }
          : fieldCandidates(job.spec);
      } catch (e) {
        out[job.anchor] = { error: e.message, candidates: [] };
      }
    }
    return out;
  })()`;
}

/**
 * 行容器候选。
 *
 * 首版只按「命中数等于页面自带计数」筛，自测证明这个判据远远不够：13 个职位的页面上
 * `.dot`、`.pointer`、`.new-icon`、`.job-name`、`.job-title` 命中数都正好是 13，
 * 一次枚举出 25 个「候选」，正确答案混在里面无从分辨。
 *
 * 行容器的语义是「把一个实体的所有字段包起来的最小容器」，所以判据加两条：
 *   1. 每个候选元素内部，恰好命中 1 个实体主键值（职位标题）
 *   2. 每个候选元素内部，还能命中至少 1 个辅助字段值（状态 / 基本信息）
 * `.dot` 类没有标题文本被排除；`.job-title` 有标题但没有状态被排除；
 * 真正的行容器同时满足三条。判据里用的都是基线里已知正确的值，不是「像不像」。
 */
/**
 * 「元素自身的直接文本」。
 *
 * 不能用「只看叶子元素」来找文本：Boss 的状态格是
 * <div class="status-box"><span class="pointer"></span> 开放中</div>——
 * 它有子元素，按叶子过滤会被整个跳过，于是状态字段永远命中不了，
 * 正确的行容器反而被判成 0/13。取直接子文本节点才是「这个元素的文字」。
 */
function buildOwnTextSnippet() {
  return `
    const ownText = (el) => {
      let s = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3) s += n.nodeValue;
      }
      return s.replace(/\\s+/g, ' ').trim();
    };
  `;
}

function buildRowCandidateSnippet() {
  return `
    const rowCandidates = (spec) => {
      const norm = (v) => (v == null ? '' : String(v)).replace(/\\s+/g, ' ').trim();
      const keys = new Set(spec.keyValues);
      const groups = (spec.fieldGroups || []).map((g) => new Set(g));
      const expected = spec.expected;

      // 1) 生成候选：按 class 聚合，命中数必须等于页面自带计数
      const seen = new Set();
      const raw = [];
      for (const el of document.querySelectorAll('*')) {
        const cls = (el.getAttribute('class') || '').trim();
        if (!cls) continue;
        const tag = el.tagName.toLowerCase();
        for (const c of cls.split(/\\s+/)) {
          if (!c) continue;
          for (const sel of ['.' + c, tag + '.' + c]) {
            if (seen.has(sel)) continue;
            seen.add(sel);
            let els;
            try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
            if (els.length === 0) continue;
            if (expected != null && els.length !== expected) continue;
            raw.push({ selector: sel, els: els });
          }
        }
      }

      // 2) 判据：每个候选元素内部必须「恰好 1 个实体主键」且「每个已知字段组都至少命中 1 个」
      //
      //    只要求「至少命中一个辅助值」是不够的：辅助值里混了低熵字段（职位标签全是「竞」），
      //    而它就在标题旁边，于是「.job-title」也满足条件混进候选。改成逐组都要命中之后，
      //    「.job-title」因为内部没有职位状态值而被排除。
      const scored = [];
      for (const cand of raw) {
        let okRows = 0;
        for (const el of cand.els) {
          let keyHits = 0;
          const groupHit = groups.map(() => false);
          for (const node of el.querySelectorAll('*')) {
            const t = ownText(node);
            if (!t) continue;
            if (keys.has(t)) keyHits++;
            for (let g = 0; g < groups.length; g++) {
              if (!groupHit[g] && groups[g].has(t)) groupHit[g] = true;
            }
          }
          if (keyHits === 1 && groupHit.every((h) => h)) okRows++;
        }
        scored.push({
          selector: cand.selector,
          els: cand.els,
          found: cand.els.length,
          rowsOk: okRows,
          full: okRows === cand.els.length,
        });
      }

      const full = scored.filter((c) => c.full);

      // 3) 同一元素集合的不同写法（「.X」与「tag.X」）归并；带标签的更具体，优先保留，
      //    因为同名 class 出现在别处时它不会误命中。
      const equiv = [];
      for (const c of full) {
        const twin = equiv.find(
          (e) => e.els.length === c.els.length && e.els.every((x, i) => x === c.els[i]),
        );
        if (!twin) {
          equiv.push(c);
        } else if (c.selector.includes('.') && /^[a-z]/.test(c.selector) && !/^[a-z]/.test(twin.selector)) {
          // 用带标签的写法替换裸 class 写法
          equiv[equiv.indexOf(twin)] = c;
        }
      }

      // 4) 嵌套候选取最外层。行容器语义上就是「实体的最外层边界」，
      //    所以在都满足判据的嵌套候选里取极大元是有依据的选择，不是随意挑一个。
      const outermost = equiv.filter((a) =>
        !equiv.some((b) => b !== a && b.els.length === a.els.length && a.els.every((x, i) => b.els[i] !== x && b.els[i].contains(x))),
      );

      const decorate = (c, isExact) => ({
        selector: c.selector,
        found: c.found,
        rowsOk: c.rowsOk,
        exact: isExact,
      });

      const exactSet = new Set(outermost.map((c) => c.selector));
      const out = [];
      for (const c of outermost) out.push(decorate(c, true));
      for (const c of scored) {
        if (exactSet.has(c.selector)) continue;
        out.push(decorate(c, false));
      }
      out.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (b.rowsOk - a.rowsOk) || (a.selector.length - b.selector.length));
      return out.slice(0, 25);
    };
  `;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  页面打开与就绪
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 就绪探测：**必须独立于被检测的锚点**。
 *
 * 首版把就绪判据写成「行锚点命中数 > 0」，自测立刻炸出问题：行锚点一失效，页面就永远
 * 判不了就绪，整页被当成「frame 缺失」跳过——而行锚点失效恰恰是这套看守最该抓到的故障。
 * 判据于是改成两条都跟锚点无关的信号：文档加载完成，且页面有实质文本。
 * 页面若声明了 pageCount（如职位页的 `.total-num`），再加一条它存在——那也是独立信号。
 */
function buildReadyExpression(pageDef) {
  const countSel = pageDef.pageCount?.selector ?? null;
  return `(() => {
    const complete = document.readyState === 'complete';
    const text = (document.body && document.body.innerText ? document.body.innerText : '').trim();
    const countSel = ${JSON.stringify(countSel)};
    const hasCount = countSel ? !!document.querySelector(countSel) : null;
    return {
      complete: complete,
      textLen: text.length,
      hasCount: hasCount,
      ready: complete && text.length > 200 && (hasCount === null || hasCount === true),
    };
  })()`;
}

/**
 * 在自己的新标签里打开目标页，返回承载内容的 frame。
 * 用新标签而不是复用工作标签：看守不该把用户正在看的页面导航走。
 *
 * frame 一旦找到就保留，即使就绪探测不过也照样返回——「页面开着但内容没出来」和
 * 「根本没找到 frame」是两种不同的结论，前者要继续往下测并如实记 found=0，
 * 后者才是真的没法测。混成一种会把锚点失效误报成环境问题。
 */
async function openPage(browser, pageDef) {
  const page = await browser.newPage();
  await page.goto(pageDef.url, { waitUntil: 'load', timeout: 60_000 });

  const readyExpr = buildReadyExpression(pageDef);
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  let frame = null;
  let attempts = 0;
  let lastReady = null;

  while (Date.now() < deadline) {
    attempts += 1;
    const found = pageDef.framePattern
      ? (page.frames().find((f) => f.url().includes(pageDef.framePattern)) ?? null)
      : page.mainFrame();
    if (found) {
      frame = found;
      try {
        lastReady = await frame.evaluate(readyExpr);
        if (lastReady?.ready) return { page, frame, attempts, ready: true, readyDetail: lastReady };
      } catch (e) {
        lastReady = { error: e.message };
      }
    }
    await new Promise((r) => setTimeout(r, PAGE_READY_POLL_MS));
  }
  return { page, frame, attempts, ready: false, readyDetail: lastReady };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  日志
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 每锚点一条 JSONL。字段刻意固定下来，方便以后累积分析：
 *   triggered —— 是否触发（断言失败）
 *   acquired  —— 是否真正获取到可用候选（枚举出至少一个 exact 复现）
 *   updated   —— 是否真正落地了改动
 * 这三个是分开的：触发了不一定推得出候选，推出候选不一定允许更新。
 * 混成一个「成功/失败」字段就看不出瓶颈在哪一环，也就无法判断这套机制值不值得继续做。
 */
async function logRecords(records) {
  await ensureDir(LOG_DIR);
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await appendFile(JSONL_PATH, text, 'utf8');
}

async function writeReport(runId, lines) {
  await ensureDir(REPORT_DIR);
  const file = path.join(REPORT_DIR, `${runId}.txt`);
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  --apply：只改常量，且只在证据充分时
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 自动更新的四个前提，缺一不可：
 *   1. 锚点白名单允许（autofix: true）
 *   2. 调用点是纯读（usage === 'read'）——点击路径永不自动改
 *   3. 候选唯一（多个等价候选说明证据不足以做选择，交给人）
 *   4. 该候选 exact 复现基线（数量、内容、无多余项全部一致）
 *
 * 落笔位置只允许是「已收拢的选择器常量」。源码里内联在 evaluate 字符串中的字面量不改——
 * 那等于对源码做正则替换，改错位置的概率远高于收益。
 */
async function applySelector(sourceFile, constName, oldSelector, newSelector) {
  const text = await readFile(sourceFile, 'utf8');
  const needle = `const ${constName} = '${oldSelector}';`;
  if (!text.includes(needle)) {
    return { ok: false, reason: `未在 ${sourceFile} 找到 \`${needle}\`，不做修改` };
  }
  const occurrences = text.split(needle).length - 1;
  if (occurrences !== 1) {
    return { ok: false, reason: `\`${needle}\` 出现 ${occurrences} 次，拒绝改写` };
  }
  const replacement = `const ${constName} = '${newSelector}';`;
  await writeFile(sourceFile, text.replace(needle, replacement), 'utf8');
  return { ok: true, from: oldSelector, to: newSelector, needle, replacement };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  主流程
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function resolveAnchors(pageKey, pageDef, selftest) {
  const anchors = {};
  for (const [key, def] of Object.entries(pageDef.anchors)) {
    const override = selftest ? SELFTEST_PROFILES[selftest]?.[pageKey]?.[key] : undefined;
    anchors[key] = { ...def, selector: override ?? def.selector, overridden: !!override };
  }
  return anchors;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runId = runIdOf();
  const report = [];
  const records = [];
  const R = (s) => {
    report.push(s);
    console.log(s);
  };

  const selftestTag = opts.selftest ? ` (selftest:${opts.selftest})` : '';
  R(`Boss 锚点看守  run=${runId}  mode=${opts.mode}${selftestTag}${opts.apply ? ' (apply)' : ''}`);
  R(`时间 ${nowIso()}`);
  R('');

  // ── 前置：服务是否正忙 ─────────────────────────────
  const busy = await serverRecentlyBusy();
  R(`服务活跃度：审计日志最后写入 ${busy.lastWrite ?? '(无)'}，空闲 ${busy.idleMs == null ? 'n/a' : Math.round(busy.idleMs / 1000) + 's'}`);
  if (busy.busy && !opts.ignoreBusy) {
    R('⏭️  最近 10 分钟内有真实工具调用，本轮跳过——避免两个 CDP 客户端同时操作把服务连接搞坏。');
    records.push({ runId, ts: nowIso(), scope: 'run', decision: 'skip', reason: 'server-busy', idleMs: busy.idleMs });
    await logRecords(records);
    const f = await writeReport(runId, report);
    console.log(`\n报告：${f}`);
    process.exit(3);
  }

  // ── 前置：浏览器体检 ───────────────────────────────
  const pre = await preflight(opts.port);
  R(`浏览器：${pre.ok ? pre.browser : '不可用'}`);
  if (!pre.ok) {
    R(`❌ ${pre.reason}`);
    records.push({ runId, ts: nowIso(), scope: 'run', decision: 'skip', reason: 'browser-unavailable', detail: pre.reason });
    await logRecords(records);
    const f = await writeReport(runId, report);
    console.log(`\n报告：${f}`);
    process.exit(3);
  }
  R(`已开标签：${pre.pages.length} 个`);
  pre.pages.forEach((u) => R(`  - ${u.slice(0, 110)}`));
  R('');

  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${opts.port}`,
      defaultViewport: null,
      protocolTimeout: CDP_PROTOCOL_TIMEOUT_MS,
    });
  } catch (e) {
    // attach 失败最常见的原因是某个 page 的渲染进程挂死（Network.enable 不返回）。
    // 这类问题必须和「锚点失效」区分开，否则报告会把浏览器故障说成前端改版。
    R(`❌ CDP 附加失败：${e.message}`);
    R('   常见原因：某个标签的渲染进程挂死。可新开一个标签并关掉挂死的那个，或重启浏览器。');
    records.push({ runId, ts: nowIso(), scope: 'run', decision: 'skip', reason: 'cdp-attach-failed', detail: e.message });
    await logRecords(records);
    const f = await writeReport(runId, report);
    console.log(`\n报告：${f}`);
    process.exit(3);
  }

  const pageKeys = opts.pages ?? Object.keys(REGISTRY);
  const baselines = {};
  let brokenTotal = 0;
  let appliedTotal = 0;

  for (const pageKey of pageKeys) {
    const pageDef = REGISTRY[pageKey];
    const anchors = resolveAnchors(pageKey, pageDef, opts.selftest);

    R(`──────── ${pageKey}：${pageDef.label} ────────`);

    let opened;
    try {
      opened = await openPage(browser, pageDef);
    } catch (e) {
      R(`  ❌ 打开页面失败：${e.message}`);
      records.push({ runId, ts: nowIso(), scope: 'page', page: pageKey, decision: 'skip', reason: 'open-failed', detail: e.message });
      continue;
    }
    const { page, frame, ready, attempts, readyDetail } = opened;

    const landedUrl = page.url();
    if (looksLoggedOut(landedUrl)) {
      R(`  ⏭️  未登录（落到 ${landedUrl.slice(0, 80)}），无法检测——不记为锚点失效。`);
      records.push({ runId, ts: nowIso(), scope: 'page', page: pageKey, decision: 'skip', reason: 'logged-out', url: landedUrl });
      await page.close().catch(() => {});
      continue;
    }
    if (!frame) {
      R(`  ❌ 未找到承载内容的 frame（期望包含 ${pageDef.framePattern}）`);
      records.push({ runId, ts: nowIso(), scope: 'page', page: pageKey, decision: 'skip', reason: 'frame-missing' });
      await page.close().catch(() => {});
      continue;
    }
    R(`  frame 就绪=${ready}（轮询 ${attempts} 次）  ${frame.url().slice(0, 100)}`);
    if (!ready) {
      // 就绪判据跟锚点无关，所以判不过说明是页面/环境问题，不是选择器问题。
      // 这里继续往下测，但把这个事实记进日志，避免后续把 found=0 读成前端改版。
      R(`  ⚠️  就绪判据未通过：${JSON.stringify(readyDetail)}  —— 下面的 found=0 可能是页面没渲染完，不能直接判为锚点失效`);
    }

    let data = null;
    const extractErrors = [];
    for (let attempt = 1; attempt <= EXTRACT_MAX_ATTEMPTS; attempt++) {
      // 每次都重新解析 frame：iframe 会在检测过程中被重挂
      const live =
        (pageDef.framePattern
          ? page.frames().find((f) => f.url().includes(pageDef.framePattern))
          : page.mainFrame()) ?? frame;
      try {
        data = await live.evaluate(buildExtractExpression(pageDef, anchors));
        if (attempt > 1) R(`  ℹ️  第 ${attempt} 次尝试提取成功（前 ${attempt - 1} 次是 CDP 层瞬时故障）`);
        break;
      } catch (e) {
        extractErrors.push(e.message);
        R(`  ⚠️  提取失败（第 ${attempt}/${EXTRACT_MAX_ATTEMPTS} 次）：${e.message}`);
        if (attempt < EXTRACT_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!data) {
      R('  ❌ 提取始终失败，本页跳过——这是环境条件，不记为锚点失效');
      records.push({
        runId,
        ts: nowIso(),
        scope: 'page',
        page: pageKey,
        decision: 'skip',
        reason: 'extract-failed',
        attempts: EXTRACT_MAX_ATTEMPTS,
        errors: extractErrors,
      });
      await page.close().catch(() => {});
      continue;
    }
    if (extractErrors.length > 0) {
      records.push({
        runId,
        ts: nowIso(),
        scope: 'page',
        page: pageKey,
        decision: 'extract-retried',
        reason: 'cdp-transient',
        attempts: extractErrors.length + 1,
        errors: extractErrors,
      });
    }

    if (pageDef.pageCount) {
      R(`  页面自带计数：「${data.pageCountText ?? ''}」→ ${data.pageCount ?? 'n/a'}`);
    }
    R(`  行数（${pageDef.rowAnchor}）= ${data.rowCount}`);

    // ── baseline 模式：只采集 ────────────────────────
    if (opts.mode === 'baseline') {
      const snap = { page: pageKey, ts: nowIso(), url: data.url, pageCount: data.pageCount, rowCount: data.rowCount, anchors: {} };
      for (const [key, def] of Object.entries(anchors)) {
        const rec = data.anchors[key];
        // 什么值可以落盘，什么不行：
        //   shape-only        —— 值天天变，进基线没意义，只记形状与每行个数
        //   structuralOnly 页 —— **一律不存值**。推荐页卡片文本是真实候选人的姓名、年龄、
        //                        期望薪资、工作经历摘要，属于第三方个人信息，不能进仓库；
        //                        而这页只做结构不变量断言，本来也用不到值。
        //                        （首次采集时确实写出了 36KB 含个人信息的基线，已删。）
        //   其余             —— 存值。职位标题/状态/薪资是本方自己发布的岗位信息，
        //                        且它是把「无 oracle 字段」变成可自动判定的唯一依据。
        //   structural-oracle —— 也不存值。它的候选靠「命中数等于页面自带计数」加
        //                        「每行恰好一个实体主键 + 每个字段组都命中」推导，用不到自己的值；
        //                        而行容器的整行文本里含每日变动的浏览/沟通计数，
        //                        存下来只会让基线看起来天天过期。
        const skipValues =
          def.kind === 'shape-only' ||
          def.kind === 'structural-oracle' ||
          pageDef.structuralOnly === true;
        snap.anchors[key] = {
          selector: def.selector,
          kind: def.kind,
          found: rec.found,
          values: skipValues ? null : rec.values,
          perRowCount: rec.perRow ? rec.perRow.map((v) => v.length) : null,
        };
        const uniq = skipValues ? null : new Set(rec.values).size;
        R(`    ${key.padEnd(12)} found=${String(rec.found).padStart(3)}  唯一值=${uniq ?? '-'}  ${def.kind}`);
      }
      baselines[pageKey] = snap;
      await ensureDir(BASELINE_DIR);
      await writeFile(path.join(BASELINE_DIR, `${pageKey}.json`), JSON.stringify(snap, null, 2), 'utf8');
      R(`  ✅ 基线已写入 ${path.join(BASELINE_DIR, `${pageKey}.json`)}`);
      records.push({ runId, ts: nowIso(), scope: 'page', page: pageKey, decision: 'baseline-saved', rowCount: data.rowCount, pageCount: data.pageCount });
      await page.close().catch(() => {});
      R('');
      continue;
    }

    // ── check 模式 ───────────────────────────────────
    const baseline = await readJsonIfExists(path.join(BASELINE_DIR, `${pageKey}.json`));
    if (!baseline) {
      R('  ⚠️  没有基线，值类锚点只能判「命中数是否为 0」，推不出候选。先跑一次 --baseline。');
    }

    // ── 第一遍：断言 ────────────────────────────────
    //
    // 行锚点是否活着要先算出来，因为它决定行内锚点的 found=0 是独立故障还是级联结果。
    // 今天 jd.ts 那次真实故障就是行容器改名：不折叠的话监控会一次报 7 条失效，
    // 真因被噪声埋掉，人根本看不出该改哪一个。
    const rowKey = pageDef.rowAnchor;
    const rowRec = data.anchors[rowKey];
    const rowDef = anchors[rowKey];
    let rowAlive = rowRec.found > 0;
    if (rowDef.kind === 'structural-oracle' && data.pageCount != null) {
      rowAlive = rowAlive && rowRec.found === data.pageCount;
    }

    const verdicts = [];
    for (const [key, def] of Object.entries(anchors)) {
      const rec = data.anchors[key];
      const record = {
        runId,
        ts: nowIso(),
        scope: 'anchor',
        page: pageKey,
        anchor: key,
        selector: def.selector,
        selftestOverride: def.overridden || false,
        kind: def.kind,
        usage: def.usage,
        autofix: !!def.autofix,
        constName: def.constName ?? null,
        found: rec.found,
        pageReady: ready,
        triggered: false,
        acquired: false,
        updated: false,
        decision: 'pass',
        reason: null,
        oracle: null,
        candidates: [],
      };

      let alive = rec.found > 0;

      if (def.conditional && !alive) {
        record.decision = 'conditional-miss';
        record.reason = '按状态才出现的元素，缺失不算失效';
        R(`    ℹ️  ${key.padEnd(12)} found=0（${record.reason}）`);
        records.push(record);
        continue;
      }

      // 级联折叠：行容器挂了，行内锚点必然取不到东西，不算它们各自失效
      if (def.scope === 'row' && key !== rowKey && !rowAlive) {
        record.decision = 'cascade';
        record.reason = `行锚点 ${rowKey} 已失效，行内锚点无法独立判定`;
        R(`    ⤵️  ${key.padEnd(12)} found=${rec.found}（级联于 ${rowKey}，不单独计为失效）`);
        records.push(record);
        continue;
      }

      if (def.kind === 'structural-oracle' && def.scope === 'page' && data.pageCount != null) {
        const pass = rec.found === data.pageCount;
        record.oracle = { type: 'pageCount', expected: data.pageCount, actual: rec.found, pass };
        if (!pass) alive = false;
      }
      if (def.kind === 'shape-only' && def.expectPerRow != null && rec.perRow && rec.perRow.length > 0) {
        const bad = rec.perRow.filter((v) => v.length !== def.expectPerRow).length;
        record.oracle = { type: 'perRowCount', expected: def.expectPerRow, badRows: bad, pass: bad === 0 };
        if (bad > 0) alive = false;
      }
      // 值类锚点：每行都应取到值，缺行说明选择器只对部分结构有效
      if (def.kind === 'value-baseline' && def.scope === 'row' && data.rowCount > 0 && rec.perRow) {
        const emptyRows = rec.perRow.filter((v) => v.length === 0).length;
        record.oracle = { type: 'rowCoverage', rows: data.rowCount, emptyRows, pass: emptyRows === 0 };
        if (emptyRows > 0) alive = false;
      }

      if (alive) {
        R(`    ✅ ${key.padEnd(12)} found=${String(rec.found).padStart(3)}${record.oracle ? '  oracle=pass' : ''}`);
        records.push(record);
        continue;
      }

      record.triggered = true;
      brokenTotal += 1;
      R(`    ❌ ${key.padEnd(12)} found=${rec.found}  失效${record.oracle ? `（oracle: ${JSON.stringify(record.oracle)}）` : ''}`);
      verdicts.push({ key, def, record });
    }

    // ── 第二遍：把所有失效锚点的候选枚举合并成一次 evaluate ──
    //
    // 逐锚点单独 evaluate 会在中途撞上 `Attempted to use detached Frame`：
    // 目标页的 iframe 会被重挂。合并成一次只需要一个存活的 frame 窗口。
    const entityKeyAnchor = Object.entries(pageDef.anchors).find(([, d]) => d.entityKey)?.[0] ?? null;
    const keyValues = entityKeyAnchor ? (baseline?.anchors?.[entityKeyAnchor]?.values ?? []) : [];
    // 按字段分组传下去，而不是拍平成一个大集合：要求「每组都命中」比「命中任意一个」强得多，
    // 低熵字段（标签全是「竞」）就不会再让标题容器蒙混过关。
    const fieldGroups = Object.entries(pageDef.anchors)
      .filter(([k, d]) => k !== entityKeyAnchor && d.kind === 'value-baseline' && d.scope === 'row')
      .map(([k]) => baseline?.anchors?.[k]?.values ?? [])
      .filter((vals) => vals.length > 0);

    const jobs = [];
    for (const v of verdicts) {
      if (pageDef.structuralOnly) continue;
      if (v.key === rowKey) {
        if (keyValues.length === 0) continue;
        jobs.push({
          anchor: v.key,
          type: 'row',
          spec: { expected: data.pageCount ?? null, keyValues, fieldGroups },
        });
        continue;
      }
      const base = baseline?.anchors?.[v.key] ?? null;
      if (!base || !Array.isArray(base.values) || base.values.length === 0) continue;
      jobs.push({
        anchor: v.key,
        type: 'field',
        spec: {
          rowSelector: rowAlive ? rowDef.selector : '',
          scope: v.def.scope === 'row' && rowAlive ? 'row' : 'page',
          wantValues: base.values,
        },
      });
    }

    let enumerated = {};
    if (jobs.length > 0) {
      // 枚举前重新解析 frame：断言到枚举之间 iframe 可能已经被重挂
      const live =
        (pageDef.framePattern
          ? page.frames().find((f) => f.url().includes(pageDef.framePattern))
          : page.mainFrame()) ?? null;
      if (!live) {
        R('    ⚠️  枚举候选时 frame 已不在，跳过本页枚举（断言结果仍然有效）');
      } else {
        try {
          enumerated = await live.evaluate(buildEnumerateExpression(jobs));
        } catch (e) {
          R(`    ⚠️  候选枚举失败：${e.message}`);
        }
      }
    }

    // ── 第三遍：决策 ───────────────────────────────
    for (const { key, def, record } of verdicts) {
      if (pageDef.structuralOnly) {
        record.decision = 'manual';
        record.reason = '该页实体不稳定（候选人每次加载都换），无法建立值基线，不推候选';
        R(`    ${key}  → 仅报告：${record.reason}`);
        records.push(record);
        continue;
      }

      const res = enumerated[key];
      if (!res) {
        record.decision = 'manual';
        record.reason = baseline ? '基线里没有可比对的值（shape-only 或未采集）' : '缺基线';
        R(`    ${key}  → 仅报告：${record.reason}`);
        records.push(record);
        continue;
      }
      if (res.error) {
        record.decision = 'manual';
        record.reason = `候选枚举出错：${res.error}`;
        R(`    ${key}  → ${record.reason}`);
        records.push(record);
        continue;
      }

      const list = res.candidates ?? [];
      record.candidates = list.slice(0, 10);
      const exact = list.filter((c) => c.exact);
      record.acquired = exact.length > 0;

      if (list.length === 0) {
        record.decision = 'manual';
        record.reason = '枚举不出任何候选';
        R(`    ${key}  → 枚举不出候选，需人工看 DOM`);
        records.push(record);
        continue;
      }

      R(`    ${key} 候选（共 ${list.length}，显示前 ${Math.min(6, list.length)}）：`);
      list.slice(0, 6).forEach((c) => {
        const detail =
          c.matched != null
            ? `复现 ${c.matched}/${c.wanted} 多余 ${c.extra}`
            : `满足判据的行 ${c.rowsOk}/${c.found}`;
        const alias = c.aliases && c.aliases.length > 0 ? `  同元素别名: ${c.aliases.slice(0, 3).join(' / ')}` : '';
        R(`       ${c.exact ? '★' : ' '} ${c.selector.padEnd(34)} found=${String(c.found).padStart(3)}  ${detail}${alias}`);
      });

      if (exact.length === 0) {
        record.decision = 'manual';
        record.reason = '没有候选能完全复现基线，证据不足';
      } else if (exact.length > 1) {
        record.decision = 'manual';
        record.reason = `有 ${exact.length} 个候选都满足全部判据，无从判断该用哪个`;
      } else if (!def.autofix) {
        record.decision = 'propose';
        record.reason = `白名单不允许自动更新（usage=${def.usage}）`;
        record.proposal = exact[0].selector;
      } else if (def.usage !== 'read') {
        record.decision = 'propose';
        record.reason = `调用点含点击/身份（usage=${def.usage}），只提议不自动改`;
        record.proposal = exact[0].selector;
      } else if (!def.constName) {
        record.decision = 'propose';
        record.reason = '源码里还是内联字面量，没有可安全落笔的常量';
        record.proposal = exact[0].selector;
      } else if (!opts.apply) {
        record.decision = 'propose';
        record.reason = '未加 --apply';
        record.proposal = exact[0].selector;
      } else {
        const applied = await applySelector(pageDef.source, def.constName, def.selector, exact[0].selector);
        if (applied.ok) {
          record.decision = 'applied';
          record.updated = true;
          record.proposal = exact[0].selector;
          record.diff = { file: pageDef.source, from: applied.from, to: applied.to };
          appliedTotal += 1;
        } else {
          record.decision = 'apply-failed';
          record.reason = applied.reason;
          record.proposal = exact[0].selector;
        }
      }
      R(`       → ${record.decision}${record.proposal ? `：${record.proposal}` : ''}${record.reason ? `（${record.reason}）` : ''}`);
      records.push(record);
    }

    await page.close().catch(() => {});
    R('');
  }

  await browser.disconnect().catch(() => {});

  R('──────── 汇总 ────────');
  const triggered = records.filter((r) => r.triggered).length;
  const acquired = records.filter((r) => r.acquired).length;
  const updated = records.filter((r) => r.updated).length;
  R(`锚点失效（triggered）= ${triggered}`);
  R(`推出可用候选（acquired）= ${acquired}`);
  R(`真正落地更新（updated）= ${updated}`);
  records.push({ runId, ts: nowIso(), scope: 'run', decision: 'done', triggered, acquired, updated });

  await logRecords(records);
  const f = await writeReport(runId, report);
  console.log(`\n报告：${f}`);
  console.log(`日志：${JSONL_PATH}`);

  if (appliedTotal > 0) {
    console.log('\n⚠️  有常量被改写，需要 npm run build 并重启服务后才会生效；改动请人工过一眼再提交。');
  }
  process.exit(brokenTotal > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(`\n💥 未预期错误：${e.stack || e.message}`);
  process.exit(1);
});
