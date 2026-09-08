import type { Browser, CDPSession, Page, Target } from 'puppeteer-core';
import { BOSS_CHAT_INDEX_URL } from './auth.js';
import { BEHAVIOR_FETCH_PATTERNS, installBehaviorEnhancements } from './behavior_enhance.js';

const SHOULD_ALLOW_CONSOLE_CLEAR =
  process.env.BOSS_BROWSER_ALLOW_CONSOLE_CLEAR === 'true' ||
  process.env.BOSS_BROWSER_ALLOW_CONSOLE_CLEAR === '1';

/**
 * 主包用 `console.log` / `console.table` 重复打印大对象，比对耗时差判断 DevTools 是否打开。
 * 默认开启对抗：把传入对象参数全部归一化为 `[object Type]` 字符串再交给原生方法，
 * V8 inspector 序列化路径只看到短字符串，耗时不再随 DevTools 状态变化。
 *
 * 设为 `true` 可恢复完整 console 形态（保留对象树展开 UX，但会重新被时间差检测命中）。
 */
const SHOULD_ALLOW_VERBOSE_CONSOLE =
  process.env.BOSS_BROWSER_ALLOW_VERBOSE_CONSOLE === 'true' ||
  process.env.BOSS_BROWSER_ALLOW_VERBOSE_CONSOLE === '1';

const BLOCKED_SECURITY_SCRIPT_PATTERNS = [
  { urlPattern: '*zhipin-security/web/boss/*', requestStage: 'Request' },
  { urlPattern: '*zhipin-boss*risk-detection*', requestStage: 'Request' },
  { urlPattern: '*bosszhipin.com/static/zhipin/geek/sdk/*', requestStage: 'Request' },
] as const;

const REPORT_REQUEST_PATTERNS = [
  { urlPattern: '*logapi.zhipin.com/dap/api/json*', requestStage: 'Request' },
  { urlPattern: '*logapi-dev.weizhipin.com/dap/api/json*', requestStage: 'Request' },
  { urlPattern: '*apm-fe.zhipin.com/wapi/zpApm/*', requestStage: 'Request' },
  { urlPattern: '*apm-fe-qa.weizhipin.com/wapi/zpApm/*', requestStage: 'Request' },
  { urlPattern: '*warlock.zhipin.com/wapi/warlock/*', requestStage: 'Request' },
  { urlPattern: '*shink.zhipin.com/wapi/dapCommon/json*', requestStage: 'Request' },
] as const;

/**
 * `about:blank` 是浏览器内置 URL，不会进入 CDP 网络拦截，因此不放在 Fetch.enable 模式里；
 * 该路径只能靠页面内 Location 守卫与 framenavigated 兜底处理。
 */
const RISK_NAVIGATION_PATTERNS = [
  { urlPattern: '*/web/common/403.html*', requestStage: 'Request' },
  { urlPattern: '*/web/common/nonsupport.html*', requestStage: 'Request' },
  { urlPattern: '*/web/user/safe/verify*', requestStage: 'Request' },
  { urlPattern: '*/web/passport/zp/403.html*', requestStage: 'Request' },
  { urlPattern: '*/web/passport/zp/verify.html*', requestStage: 'Request' },
  { urlPattern: '*/web/passport/zp/security.html*', requestStage: 'Request' },
  { urlPattern: '*/web/passport/cm/403.html*', requestStage: 'Request' },
  { urlPattern: '*/web/passport/cm/verify.html*', requestStage: 'Request' },
  { urlPattern: '*/web/passport/cm/security-check.html*', requestStage: 'Request' },
] as const;

const REPORT_REQUEST_RE =
  /(?:logapi(?:-dev)?\.(?:zhipin|weizhipin)\.com\/dap\/api\/json|apm-fe(?:-qa)?\.(?:zhipin|weizhipin)\.com\/wapi\/zpApm\/|warlock\.zhipin\.com\/wapi\/warlock\/|shink\.zhipin\.com\/wapi\/dapCommon\/json)/i;

const RISK_NAVIGATION_RE =
  /about:blank|\/web\/common\/(?:403|nonsupport)\.html|\/web\/user\/safe\/verify|\/web\/passport\/(?:zp\/(?:403|verify|security)\.html|cm\/(?:403|verify|security-check)\.html)/i;

type RequestHeaders = Record<string, string | undefined>;

type PausedKind = 'report' | 'security_script' | 'risk_navigation';

const PAUSED_LABEL: Record<PausedKind, string> = {
  report: 'report:204',
  security_script: 'block:script',
  risk_navigation: 'block:nav',
};

const POST_DATA_PREVIEW_LIMIT = 200;

function isReportRequestUrl(url: string): boolean {
  return REPORT_REQUEST_RE.test(url);
}

function isRiskNavigationUrl(url: string): boolean {
  return RISK_NAVIGATION_RE.test(url);
}

function classifyPausedRequest(url: string): PausedKind {
  if (REPORT_REQUEST_RE.test(url)) return 'report';
  if (RISK_NAVIGATION_RE.test(url)) return 'risk_navigation';
  // 落到这里的都是命中 BLOCKED_SECURITY_SCRIPT_PATTERNS 的请求；不再做 fallback 判定，
  // 一旦后续新增 patterns 但忘记同步分类正则，调用方能立刻发现而不是被静默归错类。
  return 'security_script';
}

function previewPostData(raw: string | undefined): string {
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > POST_DATA_PREVIEW_LIMIT
    ? `${compact.slice(0, POST_DATA_PREVIEW_LIMIT)}…`
    : compact;
}

/**
 * 把一行诊断信息打到 **页面 DevTools Console**（不进 Node stderr / stdout）。
 *
 * 走 CDP `Runtime.evaluate` 直接在页面默认执行上下文调 `console.info`：
 * - 终端输出完全保持干净，对非交互命令（list / recommend / chat 管道）无副作用。
 * - 只有用户主动打开 DevTools Console 才能看到，匹配 "排查时才需要" 的语义。
 * - 极早期请求（Runtime 上下文尚未创建）会失败，silently 忽略——拦截动作本身不依赖此日志。
 *
 * 注意：本函数会经过页面里 §5 的 `console.info` 包装（字符串参数原样通过），
 * 不会触发 V8 inspector 的对象序列化慢路径，对 DevTools 时间差检测无影响。
 */
function logToPageConsole(cdp: CDPSession, message: string): void {
  void cdp
    .send('Runtime.evaluate', {
      expression: `console.info(${JSON.stringify(message)})`,
      awaitPromise: false,
      returnByValue: true,
    })
    .catch(() => {
      /* 页面无可用执行上下文（极早期 / 卸载中）时丢弃此条日志即可 */
    });
}

function readRequestHeader(headers: RequestHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function buildNoContentResponseHeaders(headers: RequestHeaders) {
  const origin = readRequestHeader(headers, 'origin') ?? 'https://www.zhipin.com';
  const requestedHeaders =
    readRequestHeader(headers, 'access-control-request-headers') ??
    'content-type,x-requested-with,traceid,zp_token,__zp_stoken__';
  return [
    { name: 'access-control-allow-origin', value: origin },
    { name: 'access-control-allow-credentials', value: 'true' },
    { name: 'access-control-allow-methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
    { name: 'access-control-allow-headers', value: requestedHeaders },
    { name: 'cache-control', value: 'no-store' },
  ];
}

/**
 * 守卫脚本设计要点：
 * - 不在 `window` 上挂任何 Symbol/字符串自描述属性，避免成为指纹。
 * - 替换的方法保留 `name`，并通过包装后的 `Function.prototype.toString` 让 `fn.toString()` 返回原生形态。
 * - 改写的 accessor / 方法尽量落在 prototype 上，descriptor 形态对齐原生（`configurable: true`）。
 * - 对 `Location.prototype.href` 的 setter 也加拦截，覆盖 `location.href = ...` 直接赋值场景。
 * - 不再伪造 `navigator.plugins` 与 `window.chrome.*`：现代 Chrome 默认值已经合理，伪造反而会被
 *   `instanceof PluginArray`、对象形态比对等检测一眼分辨。
 * - 不再覆盖 `window.closed`：`close()` 已经被改写为 noop，`closed` 自然保持原生默认值。
 */
const BOSS_PAGE_GUARD_SCRIPT_TEMPLATE = `(function() {
  'use strict';

  var _Object = Object;
  var _defineProperty = _Object.defineProperty;
  var _getOwnPropertyDescriptor = _Object.getOwnPropertyDescriptor;
  var _Function = Function;
  var _origFunctionToString = _Function.prototype.toString;
  var _String = String;
  var _Map = Map;

  /** 让我们包装的函数对 fn.toString() 返回 "function NAME() { [native code] }"。 */
  var nativeSourceMap = new _Map();
  var fakeToString = function toString() {
    if (this != null) {
      var mapped = nativeSourceMap.get(this);
      if (typeof mapped === 'string') return mapped;
    }
    return _origFunctionToString.call(this);
  };
  nativeSourceMap.set(fakeToString, 'function toString() { [native code] }');
  try {
    _defineProperty(_Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (e) {}

  /** 包装替身函数：把它伪装成 "function NAME() { [native code] }"。 */
  var asNative = function(replacement, nativeName) {
    var src = 'function ' + nativeName + '() { [native code] }';
    nativeSourceMap.set(replacement, src);
    try {
      _defineProperty(replacement, 'name', {
        value: nativeName,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch (e) {}
    return replacement;
  };

  /** 替换 prototype 上的方法（保持原 descriptor 形态：默认 configurable+writable）。 */
  var replaceProtoMethod = function(proto, key, replacement) {
    try {
      var desc = _getOwnPropertyDescriptor(proto, key);
      if (!desc) return null;
      if (!desc.configurable) return null;
      _defineProperty(proto, key, {
        value: replacement,
        writable: 'writable' in desc ? !!desc.writable : true,
        configurable: true,
        enumerable: !!desc.enumerable,
      });
      return desc.value;
    } catch (e) {
      return null;
    }
  };

  /** 改写 prototype 上的 accessor：仅替换 getter/setter，保留 configurable/enumerable 形态。 */
  var replaceProtoAccessor = function(proto, key, options) {
    try {
      var desc = _getOwnPropertyDescriptor(proto, key);
      if (!desc || !desc.configurable) return null;
      var nextDesc = {
        configurable: true,
        enumerable: !!desc.enumerable,
      };
      if (options.get || desc.get) nextDesc.get = options.get || desc.get;
      if (options.set || desc.set) nextDesc.set = options.set || desc.set;
      _defineProperty(proto, key, nextDesc);
      return desc;
    } catch (e) {
      return null;
    }
  };

  // ===== navigator.webdriver：在 Navigator.prototype 上覆盖 getter，保持 accessor 形态 =====
  try {
    var navProto = Object.getPrototypeOf(navigator);
    if (navProto) {
      replaceProtoAccessor(navProto, 'webdriver', {
        get: asNative(function() { return false; }, 'get webdriver'),
      });
    }
  } catch (e) {}

  // ===== navigator.languages：仅在为空时回填，使用 prototype getter =====
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      var navProto2 = Object.getPrototypeOf(navigator);
      if (navProto2) {
        var langs = ['zh-CN', 'zh', 'en'];
        replaceProtoAccessor(navProto2, 'languages', {
          get: asNative(function() { return langs; }, 'get languages'),
        });
      }
    }
  } catch (e) {}

  // ===== window.close：改为空函数（保留 native 形态）=====
  try {
    var winProto = Object.getPrototypeOf(window);
    if (winProto) {
      replaceProtoMethod(winProto, 'close', asNative(function close() {}, 'close'));
    }
  } catch (e) {}

  // ===== history.back / forward / go =====
  try {
    var historyProto = Object.getPrototypeOf(history);
    if (historyProto) {
      var origGo = historyProto.go;
      replaceProtoMethod(historyProto, 'back', asNative(function back() {}, 'back'));
      replaceProtoMethod(historyProto, 'forward', asNative(function forward() {}, 'forward'));
      replaceProtoMethod(historyProto, 'go', asNative(function go(n) {
        if (typeof n === 'number' && n < 0) return undefined;
        return origGo.call(this, n);
      }, 'go'));
    }
  } catch (e) {}

  // ===== Location.assign / replace / href setter =====
  var BLOCK_PATH = /\\/web\\/common\\/(?:403|nonsupport)\\.html|\\/web\\/user\\/safe\\/verify|\\/web\\/passport\\/(?:zp\\/(?:403|verify|security)\\.html|cm\\/(?:403|verify|security-check)\\.html)/i;
  var isBlockedTarget = function(value) {
    var s = _String(value);
    if (s === 'about:blank') return true;
    return BLOCK_PATH.test(s);
  };
  try {
    var locProto = Location.prototype;
    var origAssign = locProto.assign;
    var origReplace = locProto.replace;
    replaceProtoMethod(locProto, 'assign', asNative(function assign(url) {
      if (isBlockedTarget(url)) return undefined;
      return origAssign.call(this, url);
    }, 'assign'));
    replaceProtoMethod(locProto, 'replace', asNative(function replace(url) {
      if (isBlockedTarget(url)) return undefined;
      return origReplace.call(this, url);
    }, 'replace'));

    var hrefDesc = _getOwnPropertyDescriptor(locProto, 'href');
    if (hrefDesc && hrefDesc.configurable && hrefDesc.set) {
      var origHrefSet = hrefDesc.set;
      _defineProperty(locProto, 'href', {
        get: hrefDesc.get,
        set: asNative(function(value) {
          if (isBlockedTarget(value)) return undefined;
          return origHrefSet.call(this, value);
        }, 'set href'),
        configurable: true,
        enumerable: !!hrefDesc.enumerable,
      });
    }
  } catch (e) {}

  // ===== console.clear：可选替身，原生形态空函数 =====
  if (!__SHOULD_ALLOW_CONSOLE_CLEAR__) {
    try {
      var consoleProtoForClear = Object.getPrototypeOf(console);
      var ownClearDesc = Object.getOwnPropertyDescriptor(console, 'clear');
      var protoClearDesc = consoleProtoForClear
        ? _getOwnPropertyDescriptor(consoleProtoForClear, 'clear')
        : null;
      var clearSrcDesc = ownClearDesc || protoClearDesc;
      if (clearSrcDesc && typeof clearSrcDesc.value === 'function') {
        try {
          _defineProperty(console, 'clear', {
            value: asNative(function clear() {}, 'clear'),
            writable: 'writable' in clearSrcDesc ? clearSrcDesc.writable !== false : true,
            configurable: true,
            enumerable: !!clearSrcDesc.enumerable,
          });
        } catch (_) {}
      }
    } catch (e) {}
  }

  // ===== console 时间差探测对抗 =====
  // 主包用 \`console.log\` / \`console.table\` 重复打印大对象（典型：50 次 × 0..500 数组），
  // 比较前后 \`performance.now()\`，DevTools 打开时 V8 inspector 会把对象逐一序列化送去，
  // 耗时显著上升即判定 DevTools 打开。对抗手段：把所有对象参数在我们这层先归一化为
  // \`[object Type]\` 这种 O(1) 字符串再交给原生方法，inspector 序列化路径只看到短字符串，
  // 耗时不再随 DevTools 状态变化。代价：DevTools 控制台中对象会显示成 \`[object Type]\`，
  // 失去对象树展开 UX；断点 / Watch / Sources / 调用栈不受影响。
  if (!__SHOULD_ALLOW_VERBOSE_CONSOLE__) {
    try {
      var _objToString = Object.prototype.toString;
      var sanitizeArgs = function(rawArgs) {
        var len = rawArgs.length;
        var out = new Array(len);
        for (var i = 0; i < len; i++) {
          var a = rawArgs[i];
          if (a !== null && typeof a === 'object') {
            try {
              out[i] = _objToString.call(a);
            } catch (_) {
              out[i] = '[object Object]';
            }
          } else if (typeof a === 'function') {
            // 函数也别交给 inspector，避免 toString 串走慢路径
            out[i] = '[Function: ' + (a.name || 'anonymous') + ']';
          } else {
            out[i] = a;
          }
        }
        return out;
      };
      var consoleProtoForLog = Object.getPrototypeOf(console);
      var consoleMethodNames = [
        'log', 'info', 'debug', 'warn', 'error',
        'table', 'dir', 'dirxml', 'trace',
        'group', 'groupCollapsed',
      ];
      for (var ci = 0; ci < consoleMethodNames.length; ci++) {
        (function(method) {
          // Chrome 把这些方法挂在 console 实例的 own property 上；
          // 部分浏览器（含历史 Firefox）会挂在 Console.prototype 上。
          // 优先取 own，否则退回 prototype；patch 一律 define 到实例上，
          // 这样既能覆盖 own 写法，又能在 prototype 形态下 shadow 掉原方法。
          var ownDesc = Object.getOwnPropertyDescriptor(console, method);
          var protoDesc = consoleProtoForLog
            ? _getOwnPropertyDescriptor(consoleProtoForLog, method)
            : null;
          var srcDesc = ownDesc || protoDesc;
          if (!srcDesc || typeof srcDesc.value !== 'function') return;
          var orig = srcDesc.value;
          var wrapped = asNative(function() {
            return orig.apply(this, sanitizeArgs(arguments));
          }, method);
          try {
            _defineProperty(console, method, {
              value: wrapped,
              writable: 'writable' in srcDesc ? srcDesc.writable !== false : true,
              configurable: true,
              enumerable: !!srcDesc.enumerable,
            });
          } catch (_) {}
        })(consoleMethodNames[ci]);
      }
    } catch (e) {}
  }
})();`;

function buildPageGuardScript(): string {
  return BOSS_PAGE_GUARD_SCRIPT_TEMPLATE
    .replace('__SHOULD_ALLOW_CONSOLE_CLEAR__', SHOULD_ALLOW_CONSOLE_CLEAR ? 'true' : 'false')
    .replace('__SHOULD_ALLOW_VERBOSE_CONSOLE__', SHOULD_ALLOW_VERBOSE_CONSOLE ? 'true' : 'false');
}

const browsersWithTargetGuard = new WeakSet<Browser>();
const pagesWithInitGuard = new WeakSet<Page>();
const pagesWithNavigationGuard = new WeakSet<Page>();
const pagesWithRequestGuard = new WeakSet<Page>();

/**
 * 单步注入的超时。
 *
 * 为什么需要它：这些步骤都是 CDP 命令，目标的渲染进程一旦僵死，命令**不会报错，而是永远
 * 不返回**。于是每次工具调用都白等到 puppeteer 的 protocolTimeout（默认 180s，本仓库配成
 * 60s）才吐一句 `Page.addScriptToEvaluateOnNewDocument timed out`——这句话既指不出是哪个
 * 页面卡住的，也说不出该怎么办。实测现场：用户连续 4 次打招呼各白等 60 秒后失败，
 * 而同一时刻读列表是正常的（读走的是已注入过的旧 Page，不触发注入）。
 *
 * 15 秒的依据：正常注入是毫秒级，实测样本里没有超过 1 秒的；给到 15 秒纯粹是为
 * 冷启动或页面正忙留余量。超过这个量级只能是僵死，再等下去没有意义。
 */
const PAGE_GUARD_STEP_TIMEOUT_MS = 15_000;

/**
 * 给单步注入套超时，并把「哪一步、哪个页面」写进错误信息。
 *
 * 注意：race 不会取消底层的 CDP 命令，它仍然挂在那里。这里要的不是取消，而是
 * **快速失败并指明现场**——把 60 秒的无信息等待换成 15 秒的可行动报错。
 */
async function withGuardStepTimeout<T>(step: string, page: Page, task: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const url = (() => {
    try {
      return page.url() || '(about:blank)';
    } catch {
      return '(url 不可读)';
    }
  })();
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `页面防护注入卡住：${step} 在 ${PAGE_GUARD_STEP_TIMEOUT_MS}ms 内没有返回。` +
              `卡住的页面：${url}。` +
              `这是该标签的渲染进程僵死，不是前端改版——CDP 命令在这种情况下不报错、只是永远不返回。` +
              `处理办法：新开一个标签并关掉这个卡住的标签（浏览器和登录态都不用动），或重启浏览器。`,
          ),
        );
      }, PAGE_GUARD_STEP_TIMEOUT_MS);
    });
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function ensurePageInitGuard(page: Page): Promise<void> {
  if (pagesWithInitGuard.has(page)) return;
  const script = buildPageGuardScript();
  // 走 puppeteer 的 evaluateOnNewDocument：内部会把脚本同步注册到主 frame CDP session，
  // 并在 OOPIF/iframe target 通过 `onAttachedToTarget` attach 时再次 addScript，
  // 因此可以覆盖隐藏 iframe 反检测对照场景。
  await withGuardStepTimeout(
    'Page.addScriptToEvaluateOnNewDocument（防护脚本）',
    page,
    page.evaluateOnNewDocument(script),
  );
  // 当前文档已在加载中或已加载完成时，evaluateOnNewDocument 不会回溯执行；
  // 这里对当前主 frame 直接注入一次，让幂等的 try/catch 守卫立即生效。
  await withGuardStepTimeout('Runtime.evaluate（对当前文档补注入）', page, page.evaluate(script)).catch(
    () => {
      /* 当前文档可能还没创建执行上下文，由后续 navigation 触发 evaluateOnNewDocument 即可 */
    },
  );
  pagesWithInitGuard.add(page);
}

function ensurePageNavigationGuard(page: Page): void {
  if (pagesWithNavigationGuard.has(page)) return;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!isRiskNavigationUrl(url)) return;
    void page.goto(BOSS_CHAT_INDEX_URL, { waitUntil: 'load', timeout: 60_000 }).catch(() => {
      console.error(`[boss-cli] 风险页导航恢复失败：${url}`);
    });
  });
  pagesWithNavigationGuard.add(page);
}

async function ensurePageRequestGuard(page: Page): Promise<void> {
  if (pagesWithRequestGuard.has(page)) return;
  const cdp = await withGuardStepTimeout('Target.attachToTarget（建 CDP session）', page, page.createCDPSession());
  await withGuardStepTimeout(
    'Network.setCacheDisabled',
    page,
    cdp.send('Network.setCacheDisabled', { cacheDisabled: true }),
  );
  await withGuardStepTimeout(
    'Fetch.enable（风险脚本拦截）',
    page,
    cdp.send('Fetch.enable', {
      patterns: [
        ...BLOCKED_SECURITY_SCRIPT_PATTERNS,
        ...BEHAVIOR_FETCH_PATTERNS,
        ...REPORT_REQUEST_PATTERNS,
        ...RISK_NAVIGATION_PATTERNS,
      ],
    }),
  );
  cdp.on('Fetch.requestPaused', (params) => {
    const url = params.request.url;
    const method = params.request.method;
    const kind = classifyPausedRequest(url);
    const label = PAUSED_LABEL[kind];

    // 命中即记录到 **页面 DevTools Console**（不污染终端输出）。
    if (kind === 'report') {
      const body = previewPostData(params.request.postData);
      logToPageConsole(
        cdp,
        body
          ? `[boss-cli][${label}] ${method} ${url} body=${body}`
          : `[boss-cli][${label}] ${method} ${url}`,
      );
      void cdp
        .send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 204,
          responsePhrase: 'No Content',
          responseHeaders: buildNoContentResponseHeaders(params.request.headers),
        })
        .catch(() => {
          // CDP send 本身失败属于真实 ops 异常，仍然报到 Node stderr，方便外层定位。
          console.error(`[boss-cli] 日志上报请求拦截响应失败：${url}`);
        });
      return;
    }

    logToPageConsole(cdp, `[boss-cli][${label}] ${method} ${url}`);
    void cdp
      .send('Fetch.failRequest', {
        requestId: params.requestId,
        errorReason: 'BlockedByClient',
      })
      .catch(() => {
        console.error(`[boss-cli] 风险请求阻断失败：${url}`);
      });
  });
  pagesWithRequestGuard.add(page);
}

export async function installBossPageGuards(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await ensurePageInitGuard(page);
  ensurePageNavigationGuard(page);
  await ensurePageRequestGuard(page);
  await withGuardStepTimeout('行为增强注入', page, installBehaviorEnhancements(page));

  // 自动拒绝所有权限弹窗（"访问此设备上的其他应用和服务"等）
  try {
    const cdp = await withGuardStepTimeout('Target.attachToTarget（权限设置）', page, page.createCDPSession());
    await withGuardStepTimeout(
      'Browser.setPermission',
      page,
      cdp.send('Browser.setPermission', {
        permission: { name: 'window-management' },
        setting: 'denied',
      }),
    ).catch(() => {});
    await cdp.detach().catch(() => {});
  } catch { /* ignore - 不影响主流程 */ }
}

async function installTargetPageGuards(target: Target): Promise<void> {
  if (target.type() !== 'page') return;
  const page = await target.page();
  if (!page || page.isClosed()) return;
  await installBossPageGuards(page);
}

export async function installBossBrowserPageGuards(browser: Browser): Promise<void> {
  if (!browsersWithTargetGuard.has(browser)) {
    browser.on('targetcreated', (target) => {
      void installTargetPageGuards(target).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[boss-cli] 新页面防护安装失败：${msg}`);
      });
    });
    browsersWithTargetGuard.add(browser);
  }

  // 这一遍是对**所有**标签的兜底扫描。真正要操作的那个页面，调用方（browser_session.ts /
  // boss_session_page.ts）会单独再调一次 installBossPageGuards，那一次失败就该让工具失败。
  //
  // 所以这里对单个标签的失败只大声记录、不中断：一个僵死标签的渲染进程已经跑不了 JS，
  // 它带来的风控风险本就趋近于零，却会因为这一遍 await 把所有工具一起拖死——今天现场就是
  // 这个形态（读列表正常、任何需要新建 Page 的操作白等 60 秒失败）。
  // 注意这不是「失败静默降级」：失败页面的 URL 会被点名，操作者据此关掉它即可。
  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  const failed: string[] = [];
  for (const page of pages) {
    try {
      await installBossPageGuards(page);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let url = '(url 不可读)';
      try {
        url = page.url() || '(about:blank)';
      } catch { /* 页面可能已不可用 */ }
      failed.push(url);
      console.error(`[boss-cli] 标签防护安装失败（已跳过该标签，不影响其它标签）：${url} —— ${msg}`);
    }
  }
  if (failed.length > 0) {
    console.error(
      `[boss-cli] 共 ${failed.length} 个标签的防护未装上：${failed.join('、')}。` +
        `这些标签的渲染进程很可能已僵死，建议关掉它们；若接下来的工具调用报同样的错，说明卡住的正是工作标签。`,
    );
  }
}
