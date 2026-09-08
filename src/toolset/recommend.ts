import type { Frame, Page } from 'puppeteer-core';
import {
  JOB_SEARCH_ACTION_GAP_MS,
  JOB_SELECT_ACTION_GAP_MS,
  RESUME_PREVIEW_OPEN_GAP_MS,
  sleepRandom,
  humanClick,
} from '../browser/index.js';
import { formatLoggedOutMessage, isWebUserLoginUrl } from '../common/auth.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { ensurePage, isPageAlive } from '../common/ensure_page.js';
import { rethrowWaitTimeout } from '../common/wait_timeout.js';

const BOSS_CHAT_RECOMMEND_URL = 'https://www.zhipin.com/web/chat/recommend';

export type RecommendCandidate = {
  geekId: string;
  name: string;
  salary: string;
  baseInfo: string;
  expect: string;
  experience: string;
  advantage: string;
  highlights: string[];
  canGreet: boolean;
  hasHistoryChat: boolean;
  /** 卡片为灰色「已看过」样式（如 `.candidate-card-wrap.has-viewed` / `.card-inner.has-viewed`） */
  hasViewed: boolean;
};
/** 会话内记录：通过 greet 新出现的推荐卡片（以 geekId 识别） */
const sessionGreetProducedGeekIds = new Set<string>();

/**
 * 候选人卡片的**锚点**：一个候选人在 DOM 里有且只有一个 `.card-inner[data-geekid]`。
 *
 * 为什么不按容器 class 枚举：上一版用的是
 * `'.candidate-card-wrap, .card-list .card-item, .geek-list .geek-card'`，
 * 注释把这三者当成「新旧版本并存、互斥」的兼容写法。但线上真实 DOM 里
 * `li.card-item` 是列表项、`div.candidate-card-wrap` 是卡片本体，两者是**父子关系**：
 *
 *     ul.card-list
 *       li.card-item                        ← 命中 '.card-list .card-item'
 *         div.candidate-card-wrap           ← 命中 '.candidate-card-wrap'
 *           div.card-inner[data-geekid]
 *           div.operate-side
 *             div.button-chat-wrap          ← 「打招呼」按钮在这里，不在 card-inner 内
 *
 * 于是同一张卡被多选择器命中两次，`querySelectorAll` 按文档顺序先返回外层 li、
 * 紧跟内层 div，列表里每个人相邻出现两遍——「共 90 人」其实只有 45 个真人，
 * 筛 100 个只能拿到 50 个。现场实测：15 个 geekId，每个都被数了 2 次。
 *
 * 改用 geekId 锚点后天然一人一条，且自动跳过列表里没有 geekId 的插入行
 * （分隔条之类，正是它让 `.card-item` 比 `.candidate-card-wrap` 多出 1 个），
 * 不再需要 `.filter((x) => x.name)` 这种间接过滤。
 */
const RECOMMEND_CARD_ANCHOR_SELECTOR = '.card-inner[data-geekid]';

/**
 * 卡片根：由锚点 `closest()` 上溯得到。字段必须从根上取而不是从锚点上取——
 * 按钮区 `.button-chat-wrap` 与沟通记录图标是 `.card-inner` 的**兄弟节点**，
 * 在锚点内部查不到（实测锚点内 0 个、根内 15 个）。
 */
const RECOMMEND_CARD_ROOT_SELECTOR = '.candidate-card-wrap';

/**
 * 注入页面的公共片段：按锚点枚举候选人卡片根。
 *
 * 四处 evaluate（就绪等待、读列表、打招呼、简历预览）共用这一份定义。
 * 上一版每处各自写一遍 `querySelectorAll(cardSel)`，选择器语义一旦理解错，
 * 四处会同时错且改一处不会同步——重复计数就是这么漏过去的。
 *
 * 片段执行后向外提供：
 * - `cards`：卡片根数组，与候选人一一对应
 * - `__orphans`：有 `data-geekid` 却找不到卡片根的 geekId（正常为空；非空说明 Boss 改了 DOM）
 * - `__anchorOf(root)` / `__geekIdOf(root)` / `__nameOf(root)`
 */
const RECOMMEND_CARD_ENUM_JS = `
    const __anchorSel = ${JSON.stringify(RECOMMEND_CARD_ANCHOR_SELECTOR)};
    const __rootSel = ${JSON.stringify(RECOMMEND_CARD_ROOT_SELECTOR)};
    const __orphans = [];
    const cards = [];
    Array.from(document.querySelectorAll(__anchorSel)).forEach((anchor) => {
      const root = anchor.closest(__rootSel);
      if (root) {
        cards.push(root);
      } else {
        __orphans.push(anchor.getAttribute("data-geekid") || "(无 geekId)");
      }
    });
    const __anchorOf = (root) => root.querySelector(__anchorSel);
    const __geekIdOf = (root) => {
      const a = __anchorOf(root);
      return a ? (a.getAttribute("data-geekid") || "") : "";
    };
    const __nameOf = (root) => {
      const n = root.querySelector(".name-wrap .name") || root.querySelector(".name");
      return (n && n.textContent ? n.textContent : "").replace(/\\s+/g, " ").trim();
    };
`;

export function isBossChatRecommendUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zhipin.com')) {
      return false;
    }
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return p === '/web/chat/recommend';
  } catch {
    return false;
  }
}

async function getRecommendFrame(page: Page): Promise<Frame> {
  const timeoutMs = 18_000;
  // 这一句超时原本报的是裸的 `Waiting failed: 18000ms exceeded`：不说等的是哪个选择器、
  // 也不说页面在哪。更糟的是下面 ensureRecommendFrameReady 的等待也是 18000ms，
  // 两条完全不同的故障（主文档没有推荐 iframe / iframe 有了但列表没挂载）报出同一句话。
  const iframe = await page
    .waitForSelector('iframe[name="recommendFrame"]', { timeout: timeoutMs })
    .catch((e: unknown) =>
      rethrowWaitTimeout(
        e,
        `等推荐 iframe 超时：主文档在 ${timeoutMs}ms 内没有出现 iframe[name="recommendFrame"]。` +
          `当前页面：${page.url() || 'unknown'}；` +
          `已有 frame：${page.frames().map((f) => f.url() || '(about:blank)').join('｜') || '（无）'}。` +
          `常见原因是页面并不在推荐页、或主文档尚未渲染完；这一步不做导航，请先确认页面位置。`,
      ),
    );
  if (!iframe) {
    throw new Error('未找到推荐 iframe（iframe[name="recommendFrame"]）。');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await iframe.contentFrame();
    if (frame && frame.url().includes('/web/frame/recommend')) {
      return frame;
    }
    await sleepRandom(120, 220);
  }

  const iframeSrc = (await page.evaluate(
    `(() => document.querySelector('iframe[name="recommendFrame"]')?.getAttribute("src") ?? "")()`,
  )) as string;
  const frameUrls = page.frames().map((f) => f.url()).join(' | ');
  throw new Error(
    `已检测到推荐 iframe，但无法获取其页面上下文。iframe src：${iframeSrc || 'unknown'}；frames：${frameUrls || 'empty'}`,
  );
}

async function ensureRecommendFrameReady(frame: Frame): Promise<void> {
  const timeoutMs = 18_000;
  await frame
    .waitForFunction(
      `(() => {
      const sel = ${JSON.stringify(RECOMMEND_CARD_ANCHOR_SELECTOR)};
      if (document.querySelector(sel)) return true;
      // 列表容器已挂载但一个候选人都没有，也算就绪（空列表是正常状态，不该等到超时）。
      const root = document.querySelector(".card-list, .geek-list-wrap .geek-list");
      return !!root;
    })()`,
      { timeout: timeoutMs },
    )
    .catch((e: unknown) =>
      rethrowWaitTimeout(
        e,
        `等推荐列表就绪超时：iframe 已经在了，但 ${timeoutMs}ms 内既没出现候选人锚点` +
          `（${RECOMMEND_CARD_ANCHOR_SELECTOR}）也没出现列表容器（.card-list / .geek-list-wrap .geek-list）。` +
          `iframe 地址：${frame.url() || 'unknown'}。` +
          `这与「主文档里找不到推荐 iframe」是两回事：iframe 在、内容没出来，` +
          `要么 Boss 改了列表 DOM，要么该 iframe 的渲染进程已经不干活了。`,
      ),
    );
}

async function readCurrentRecommendJobLabel(frame: Frame): Promise<string> {
  return (await frame.evaluate(`(() => {
    const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
    return norm(document.querySelector(".job-selecter-wrap .ui-dropmenu-label")?.textContent);
  })()`)) as string;
}

async function waitForRecommendJobDropdownReady(frame: Frame): Promise<void> {
  await frame.waitForFunction(
    `(() => {
      const options = document.querySelector(".job-selecter-options");
      if (!(options instanceof HTMLElement)) return false;
      const rect = options.getBoundingClientRect();
      const style = window.getComputedStyle(options);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      return !!options.querySelector(".top-chat-search .chat-job-search");
    })()`,
    { timeout: 8_000 },
  );
}

async function waitForRecommendJobSearchResults(frame: Frame, keyword: string): Promise<void> {
  await frame.waitForFunction(
    `(() => {
      const kw = ${JSON.stringify(keyword)};
      const norm = (v) => (v ?? "").replace(/\\s+/g, "").trim().toLowerCase();
      const rows = Array.from(document.querySelectorAll(".job-selecter-options .job-list .job-item"));
      if (rows.length === 0) return false;
      if (!kw) return true;
      return rows.some((el) => {
        const label = norm(el.querySelector(".label")?.textContent || el.textContent || "");
        return label.includes(norm(kw));
      });
    })()`,
    { timeout: 10_000 },
  );
}

async function waitForRecommendJobSelected(frame: Frame, expectedLabel: string): Promise<void> {
  await frame.waitForFunction(
    `(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const current = norm(document.querySelector(".job-selecter-wrap .ui-dropmenu-label")?.textContent);
      return !!current && current === ${JSON.stringify(expectedLabel)};
    })()`,
    { timeout: 10_000 },
  );
  await ensureRecommendFrameReady(frame);
}

export async function selectRecommendJob(frame: Frame, keyword: string): Promise<string> {
  const kw = keyword.trim();
  if (!kw) {
    return readCurrentRecommendJobLabel(frame);
  }
  const kwLiteral = JSON.stringify(kw);

  const opened = (await frame.evaluate(`(() => {
    const host = document.querySelector(".job-selecter-wrap .ui-dropmenu-label");
    if (!(host instanceof HTMLElement)) return false;
    host.scrollIntoView({ block: "center", inline: "nearest" });
    host.click();
    return true;
  })()`)) as boolean;
  if (!opened) {
    throw new Error('未找到岗位下拉入口（.job-selecter-wrap .ui-dropmenu-label）。');
  }
  await sleepRandom(JOB_SELECT_ACTION_GAP_MS.min, JOB_SELECT_ACTION_GAP_MS.max);
  await waitForRecommendJobDropdownReady(frame);

  const searched = (await frame.evaluate(`(() => {
    const kw = ${kwLiteral};
    const input = document.querySelector(".job-selecter-options .top-chat-search .chat-job-search");
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    input.value = kw;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`)) as boolean;
  if (!searched) {
    throw new Error('已打开岗位下拉，但未找到职位搜索框（.chat-job-search）。');
  }
  await sleepRandom(JOB_SEARCH_ACTION_GAP_MS.min, JOB_SEARCH_ACTION_GAP_MS.max);
  await waitForRecommendJobSearchResults(frame, kw);

  const picked = (await frame.evaluate(`(() => {
    const kw = ${kwLiteral};
    const norm = (v) => (v ?? "").replace(/\\s+/g, "").trim().toLowerCase();
    const rows = Array.from(document.querySelectorAll(".job-selecter-options .job-list .job-item"));
    if (rows.length === 0) return { ok: false, reason: "empty" };
    const target = rows.find((el) => {
      const label = norm(el.querySelector(".label")?.textContent || el.textContent || "");
      return label.includes(norm(kw));
    });
    if (!(target instanceof HTMLElement)) return { ok: false, reason: "not_found" };
    const label = (target.querySelector(".label")?.textContent ?? target.textContent ?? "")
      .replace(/\\s+/g, " ")
      .trim();
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.click();
    return { ok: true, label };
  })()`)) as { ok: boolean; label?: string; reason?: string };
  if (!picked.ok) {
    throw new Error(`未找到匹配岗位“${kw}”。`);
  }
  const label = picked.label ?? kw;
  await sleepRandom(JOB_SELECT_ACTION_GAP_MS.min, JOB_SELECT_ACTION_GAP_MS.max);
  await waitForRecommendJobSelected(frame, label);
  return label;
}

export async function ensureInRecommendPage(page: Page): Promise<Frame> {
  await ensurePage(page, {
    name: '推荐列表页',
    targetUrl: BOSS_CHAT_RECOMMEND_URL,
    matches: isBossChatRecommendUrl,
  });
  const frame = await getRecommendFrame(page);
  await ensureRecommendFrameReady(frame);
  return frame;
}

/**
 * 供 `preview` 使用：不导航；若当前主页面不在推荐页或未就绪推荐 iframe，直接抛错。
 */
export async function assertRecommendPageReady(
  page: Page,
  actionName: string,
): Promise<Frame> {
  if (!isBossChatRecommendUrl(page.url())) {
    // 页面被弹到登录页时，「当前不在推荐列表页」这句话虽然没错，却指不到根因，
    // 而且会让人以为只要导航回去就行——实际上导航回去还会再被弹出来。
    if (isWebUserLoginUrl(page.url())) {
      throw new Error(formatLoggedOutMessage(page.url(), actionName));
    }
    throw new Error(`当前不在推荐列表页（/web/chat/recommend），无法${actionName}。当前页面：${page.url() || 'unknown'}`);
  }
  // 本函数按契约**不导航**（导航会把当前列表上下文冲掉），所以页面死了只能报错。
  // 但必须在 getRecommendFrame 之前判：否则会先在 waitForSelector 上白等 18 秒，
  // 最后抛一句 `frame got detached`，看不出是「标签页被回收」还是「Boss 改了 DOM」。
  if (!(await isPageAlive(page))) {
    throw new Error(
      `推荐页已无可执行上下文，无法${actionName}（渲染进程被回收，常见于标签页长时间空闲）。\n`
        + '这与登录态无关，**不要调用 boss_login**——它会把标签导航到登录页，列表会彻底丢失。\n'
        + '请先调用 boss_recommend 重新载入推荐列表（它会自动重新加载页面），再重试本操作。\n'
        + '注意：重新载入后列表是新的一批，本轮筛选的序号已失效，需要重新读取。',
    );
  }
  const frame = await getRecommendFrame(page);
  await ensureRecommendFrameReady(frame);
  return frame;
}

export async function assertRecommendPageReadyForPreview(page: Page): Promise<Frame> {
  return assertRecommendPageReady(page, '预览候选人');
}

export async function readRecommendList(frame: Frame): Promise<RecommendCandidate[]> {
  const read = (await frame.evaluate(`(() => {
    ${RECOMMEND_CARD_ENUM_JS}
    const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
    const candidates = cards.map((root) => {
      const anchor = __anchorOf(root);
      const hasViewed = Boolean(
        root.classList.contains("has-viewed") ||
          (anchor && anchor.classList.contains("has-viewed")),
      );
      const baseInfo = Array.from(root.querySelectorAll(".base-info span"))
        .map((el) => norm(el.textContent))
        .filter(Boolean)
        .join(" / ");
      const expect =
        norm(root.querySelector(".expect-wrap .content")?.textContent) ||
        norm(root.querySelector(".expect-wrap .join-text-wrap")?.textContent);
      const highlightLabels = [
        ...Array.from(root.querySelectorAll(".operate .labels .label")),
        ...Array.from(root.querySelectorAll(".tags-wrap .tag-item")),
      ]
        .map((el) => norm(el.textContent))
        .filter(Boolean);
      const greetBtn = root.querySelector(".button-chat-wrap .btn.btn-greet");
      const btnCls = greetBtn?.className ?? "";
      const disabled =
        !greetBtn ||
        /disabled|forbid|ban/i.test(btnCls) ||
        greetBtn.getAttribute("disabled") !== null;
      const hasHistoryChat = (() => {
        if (root.querySelector(".tooltip-wrap.chat-history .icon-chat-history")) return true;
        return Array.from(root.querySelectorAll("use")).some((u) => {
          const href = u.getAttribute("href") ?? u.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
          return href.includes("icon-chat-history");
        });
      })();
      return {
        geekId: __geekIdOf(root),
        name: __nameOf(root),
        salary: norm(root.querySelector(".salary-wrap span")?.textContent),
        baseInfo,
        expect,
        experience: norm(root.querySelector(".experience-wrap .join-text-wrap")?.textContent),
        advantage: norm(root.querySelector(".geek-desc .content")?.textContent),
        highlights: [...new Set(highlightLabels)],
        canGreet: !disabled,
        hasHistoryChat,
        hasViewed,
      };
    });
    return { candidates, orphans: __orphans };
  })()`)) as { candidates: RecommendCandidate[]; orphans: string[] };

  // 锚点找不到卡片根 = Boss 改了卡片 DOM。这种情况必须报出来：静默跳过会让列表凭空少人，
  // 而少掉的人在后续筛选里根本不会被发现。
  if (read.orphans.length > 0) {
    throw new Error(
      `推荐列表结构异常：${read.orphans.length} 个候选人锚点（${RECOMMEND_CARD_ANCHOR_SELECTOR}）`
        + `找不到所属卡片根（${RECOMMEND_CARD_ROOT_SELECTOR}）。`
        + `示例 geekId：${read.orphans.slice(0, 5).join('、')}。`
        + '请重新核对本文件的卡片选择器（可用 skills/boss-frontend-analysis 的 DOM 检测）。',
    );
  }
  return read.candidates;
}

export function renderRecommendList(candidates: RecommendCandidate[]): string {
  if (candidates.length === 0) {
    return '推荐列表为空。';
  }
  const greetProduced: RecommendCandidate[] = [];
  const normal: RecommendCandidate[] = [];
  candidates.forEach((c) => {
    if (c.geekId && sessionGreetProducedGeekIds.has(c.geekId)) {
      greetProduced.push(c);
    } else {
      normal.push(c);
    }
  });

  const renderItems = (title: string, items: RecommendCandidate[]): string[] => {
    const lines: string[] = [];
    lines.push(`${title}（${items.length}）`);
    if (items.length === 0) {
      lines.push('  - 暂无');
      return lines;
    }
    items.forEach((m, idx) => {
      const advantageText =
        m.advantage ||
        (m.highlights.length > 0 ? m.highlights.slice(0, 3).join(' / ') : '（无）');
      const fields = [
        m.salary ? `薪资:${m.salary}` : '',
        m.baseInfo ? `信息:${m.baseInfo}` : '',
        m.expect ? `期望:${m.expect}` : '',
        m.experience ? `经历:${m.experience}` : '',
        m.hasHistoryChat ? '同事沟通过' : '',
        m.canGreet ? '可打招呼' : '已打招呼',
      ]
        .filter(Boolean)
        .join('｜');
      const nameWithViewed = m.hasViewed ? `${m.name} | 看过` : m.name;
      lines.push(`  - ${idx + 1}. ${nameWithViewed}｜${fields}`);
      lines.push(`    优势: ${advantageText}`);
      // geekId 必须渲染出来：调用方（LLM）只能把它看见的东西传给 pool_add，
      // 而 pool_add 存下 geekId 是后续「按身份而不是按姓名打招呼」的前提。
      // 以前这里不渲染，身份就在这一步断链了，打招呼只能拿姓名回 DOM 里猜。
      lines.push(`    geekId: ${m.geekId || '（未取到）'}`);
    });
    return lines;
  };

  const out: string[] = [];
  out.push(`推荐列表（按来源分组）：共 ${candidates.length} 人。`);
  out.push('');
  out.push(...renderItems('常规推荐', normal));
  out.push('');
  out.push(...renderItems('打招呼产生的推荐', greetProduced));

  return out.join('\n');
}

/** 滚动到位后等待惰性渲染/滚动落定，再去量按钮几何。 */
const GREET_SCROLL_SETTLE_MS = { min: 200, max: 500 } as const;

/**
 * 点击「打招呼」。
 *
 * 为什么不能直接拿坐标就点：CDP 只能按坐标派发可信输入（`Input.dispatchMouseEvent`），
 * 页面内 `el.click()` 是 `isTrusted: false` 的合成事件、缺整条 pointer/mouse 事件流，
 * 属于明显的自动化特征。坐标既然去不掉，就必须在派发前把「这个坐标确实落在目标按钮上」
 * 验证掉——否则一次飘掉的坐标会静默点空、甚至点到隔壁卡片，而配额已经花出去了。
 *
 * 派发前两道校验，任何一道不过都直接抛错，不重试、不兜底：
 *  1. 标记按钮时同步 `scrollIntoView`，随后在 iframe 内用 `elementFromPoint` 确认按钮自身可命中。
 *     `clickablePoint()` 内部会把 client rect 裁剪到 iframe 的 `clientWidth/clientHeight`，
 *     列表被滚走时裁剪后面积为 0，只会抛一句无信息量的
 *     `Node is either not clickable or not an Element`（历史事故：批量抓简历把列表滚到下方后，
 *     对列表最前面几个人打招呼全军覆没，报错完全看不出是滚动位置问题）。
 *  2. 换算出页面级坐标后，在**父页**再用 `elementFromPoint` 确认该点仍落在推荐 iframe 上。
 *     iframe 内部的命中测试看不见父页盖上来的浮层（如残留的 c-resume 简历面板）。
 *
 * 派发后的「是否真的生效」由调用方在付费墙检查之后用 {@link assertGreetTookEffect} 复查：
 * 那一步必须排在 paywall 判定之后，否则付费墙拦截会被误报成坐标落空。
 *
 * @param target       候选人姓名，只在没有 `expectGeekId` 时用于定位；始终用于错误文案。
 * @param expectGeekId 平台身份。传了就**只**按它定位，姓名一概不看（见函数体内的定位规则）。
 */
export async function clickGreet(
  frame: Frame,
  target: string,
  expectGeekId?: string,
): Promise<{ message: string; name: string; geekId: string }> {
  const targetLiteral = JSON.stringify(target.trim());
  const expectLiteral = JSON.stringify((expectGeekId ?? '').trim());
  const result = (await frame.evaluate(
    `(() => {
      ${RECOMMEND_CARD_ENUM_JS}
      const raw = ${targetLiteral};
      const wantGeekId = ${expectLiteral};
      if (cards.length === 0) {
        return { kind: "empty" };
      }

      // 定位规则，两条互斥的路，取决于调用方有没有给出平台身份：
      //
      // A) 给了 geekId —— 只按 geekId 精确匹配，完全不看姓名。
      //    geekId 是跨会话稳定的唯一身份，匹配不上就是「这个人已经不在当前列表里」，
      //    此时必须报错而不是退回姓名匹配：退回去正是「把配额花在同名/近名的另一个人身上」的来路。
      //
      // B) 没给 geekId（深度搜索列表不暴露 geekId，只能走这条）—— 只按**精确**姓名匹配。
      //    子串命中不再当作结果，而是明确报错：以前 exact 为空时会回落到 includes，
      //    「李响」在列表里已刷掉、而「李响东」还在，就会静默打给李响东，
      //    并且事后校验也抓不出来（校验用的是实际点中那张卡的 geekId，自然自洽）。
      if (wantGeekId) {
        const byId = cards.filter((root) => __geekIdOf(root) === wantGeekId);
        if (byId.length === 0) {
          return { kind: "geekid_not_found", target: raw, geekId: wantGeekId };
        }
        if (byId.length > 1) {
          return { kind: "geekid_duplicated", target: raw, geekId: wantGeekId, count: byId.length };
        }
        return prepare(byId[0]);
      }

      const exact = cards.filter((root) => __nameOf(root) === raw);
      if (exact.length === 0) {
        const partial = cards.filter((root) => __nameOf(root).includes(raw));
        if (partial.length > 0) {
          return {
            kind: "only_partial",
            target: raw,
            names: partial.map(__nameOf),
            geekIds: partial.map(__geekIdOf),
          };
        }
        return { kind: "not_found", target: raw };
      }
      if (exact.length > 1) {
        return {
          kind: "ambiguous",
          target: raw,
          names: exact.map(__nameOf),
          geekIds: exact.map(__geekIdOf),
        };
      }
      return prepare(exact[0]);

      function prepare(targetCard) {

      const name = __nameOf(targetCard);
      const geekId = __geekIdOf(targetCard);
      const btn = targetCard.querySelector(".button-chat-wrap .btn.btn-greet");
      if (!(btn instanceof HTMLElement)) {
        return { kind: "no_btn", name };
      }
      const cls = btn.className ?? "";
      const disabled = /disabled|forbid|ban/i.test(cls) || btn.getAttribute("disabled") !== null;
      if (disabled) {
        return { kind: "disabled", name };
      }
      // 标记按钮供外部按同一 frame 定位；顺手滚到可视区中间，否则 clickablePoint() 会因
      // 裁剪后面积为 0 而失败（与本文件 selectRecommendJob 的处理方式一致）。
      btn.setAttribute("data-boss-greet-target", "1");
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      return { kind: "ready_to_click", name, geekId };
      }
    })()`,
  )) as
    | { kind: 'empty' }
    | { kind: 'not_found'; target: string }
    | { kind: 'only_partial'; target: string; names: string[]; geekIds: string[] }
    | { kind: 'ambiguous'; target: string; names: string[]; geekIds: string[] }
    | { kind: 'geekid_not_found'; target: string; geekId: string }
    | { kind: 'geekid_duplicated'; target: string; geekId: string; count: number }
    | { kind: 'no_btn'; name: string }
    | { kind: 'disabled'; name: string }
    | { kind: 'ready_to_click'; name: string; geekId: string };

  switch (result.kind) {
    case 'empty':
      throw new Error('推荐列表为空，无法执行打招呼。');
    case 'not_found':
      throw new Error(`未在推荐列表中找到目标：${result.target}`);
    case 'only_partial':
      throw new Error(
        `未在推荐列表中找到姓名恰好为“${result.target}”的候选人；`
          + `有 ${result.names.length} 人的姓名包含它（${result.names.join('、')}），但那是**不同的人**，`
          + '已中止以免把配额花在没筛过的人身上。'
          + '请用 boss_recommend 重新读取列表确认此人是否还在，或用 geekId 精确指定。',
      );
    case 'ambiguous':
      throw new Error(
        `目标“${result.target}”在推荐列表中命中 ${result.names.length} 个不同候选人`
          + `（${result.names.join('、')}；geekId：${result.geekIds.join('、')}），`
          + '无法确定是谁，已中止以免打错人。请改用 geekId 精确指定。',
      );
    case 'geekid_not_found':
      throw new Error(
        `按 geekId=${result.geekId} 未在当前推荐列表中找到“${result.target}”，此人已不在列表里。`
          + '推荐列表是易失的（页面刷新或重新载入就会换一批），请用 boss_recommend 重新读取后再决定。'
          + '未按姓名退化匹配——那样会把配额花在同名或近名的另一个人身上。',
      );
    case 'geekid_duplicated':
      throw new Error(
        `按 geekId=${result.geekId} 在当前列表里命中了 ${result.count} 张卡片，这不应该发生`
          + '（geekId 在一页里必须唯一）。可能是 Boss 改了卡片 DOM 结构，已中止。',
      );
    case 'no_btn':
      throw new Error(`候选人 ${result.name} 缺少“打招呼”按钮，无法执行。`);
    case 'disabled':
      throw new Error(`候选人 ${result.name} 已打招呼。`);
    case 'ready_to_click': {
      // 标记是打在 `recommendFrame` 这个 iframe 的文档里的，必须在**同一个 frame** 内定位。
      // 之前用 `humanClickSelector(frame.page(), ...)`，那是在顶层 document 里 querySelector，
      // iframe 内的按钮永远查不到，于是必然抛「元素未找到: [data-boss-greet-target="1"]」。
      // `clickablePoint()` 会把 frame 偏移算进去，得到页面级坐标，仍可走贝塞尔拟人点击。
      const greetPage = frame.page();
      await sleepRandom(GREET_SCROLL_SETTLE_MS.min, GREET_SCROLL_SETTLE_MS.max);
      await assertGreetButtonHittableInFrame(frame, result.name);
      const btn = await frame.$('[data-boss-greet-target="1"]');
      if (!btn) {
        throw new Error(`候选人 ${result.name} 的“打招呼”按钮标记已失效（推荐列表可能已刷新）。`);
      }
      try {
        const point = await btn.clickablePoint();
        await assertGreetPointHitsRecommendFrame(greetPage, result.name, point);
        await humanClick(greetPage, point.x, point.y);
      } finally {
        await btn.dispose();
      }
      // 清除标记
      await frame.evaluate(`(() => {
        const el = document.querySelector('[data-boss-greet-target="1"]');
        if (el) el.removeAttribute('data-boss-greet-target');
      })()`);
      return {
        message: `已对 ${result.name} 点击“打招呼”。`,
        name: result.name,
        geekId: result.geekId,
      };
    }
    default: {
      const _x: never = result;
      throw new Error(`未知结果：${String(_x)}`);
    }
  }
}

/**
 * 第一道：在推荐 iframe 内确认已标记的按钮中心点命中按钮自身。
 * 把 `clickablePoint()` 那句无信息量的报错换成能定位的原因（滚动位置 / 被谁遮挡）。
 */
async function assertGreetButtonHittableInFrame(frame: Frame, name: string): Promise<void> {
  const hit = (await frame.evaluate(`(() => {
    const el = document.querySelector('[data-boss-greet-target="1"]');
    if (!(el instanceof HTMLElement)) {
      return { ok: false, reason: "marker_lost" };
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      return { ok: false, reason: "zero_box", w: Math.round(r.width), h: Math.round(r.height) };
    }
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
      return {
        ok: false,
        reason: "out_of_view",
        cx: Math.round(cx),
        cy: Math.round(cy),
        vw: Math.round(vw),
        vh: Math.round(vh),
      };
    }
    const top = document.elementFromPoint(cx, cy);
    if (!top) {
      return { ok: false, reason: "no_hit", cx: Math.round(cx), cy: Math.round(cy) };
    }
    if (!(top === el || el.contains(top))) {
      return { ok: false, reason: "covered", by: top.className || top.tagName };
    }
    return { ok: true };
  })()`)) as
    | { ok: true }
    | { ok: false; reason: 'marker_lost' }
    | { ok: false; reason: 'zero_box'; w: number; h: number }
    | { ok: false; reason: 'out_of_view'; cx: number; cy: number; vw: number; vh: number }
    | { ok: false; reason: 'no_hit'; cx: number; cy: number }
    | { ok: false; reason: 'covered'; by: string };

  if (hit.ok) {
    return;
  }
  const prefix = `候选人 ${name} 的“打招呼”按钮不可点击`;
  switch (hit.reason) {
    case 'marker_lost':
      throw new Error(`${prefix}：按钮标记在滚动后丢失（推荐列表可能已重新渲染）。`);
    case 'zero_box':
      throw new Error(`${prefix}：按钮尺寸为 ${hit.w}×${hit.h}，未参与布局。`);
    case 'out_of_view':
      throw new Error(
        `${prefix}：滚动后中心点仍在 iframe 可视区外`
          + `（点 ${hit.cx},${hit.cy}；可视区 ${hit.vw}×${hit.vh}）。`,
      );
    case 'no_hit':
      throw new Error(`${prefix}：坐标 ${hit.cx},${hit.cy} 上没有任何元素。`);
    case 'covered':
      throw new Error(`${prefix}：被「${hit.by}」遮挡。`);
    default: {
      const _x: never = hit;
      throw new Error(`${prefix}：未知原因 ${String(_x)}`);
    }
  }
}

/**
 * 第二道：在父页确认页面级坐标仍落在推荐 iframe 上。
 * iframe 内的命中测试看不见父页浮层，这一层专门拦「简历面板/弹窗盖住了整个列表」。
 */
async function assertGreetPointHitsRecommendFrame(
  page: Page,
  name: string,
  point: { x: number; y: number },
): Promise<void> {
  const hit = (await page.evaluate(`(() => {
    const x = ${JSON.stringify(point.x)};
    const y = ${JSON.stringify(point.y)};
    const top = document.elementFromPoint(x, y);
    if (!top) {
      return { ok: false, reason: "no_hit" };
    }
    const tag = (top.tagName || "").toLowerCase();
    if (tag !== "iframe") {
      return { ok: false, reason: "covered", by: top.className || tag };
    }
    const frameName = top.getAttribute("name") || "";
    if (frameName !== "recommendFrame") {
      return { ok: false, reason: "wrong_frame", by: frameName || "(未命名 iframe)" };
    }
    return { ok: true };
  })()`)) as
    | { ok: true }
    | { ok: false; reason: 'no_hit' }
    | { ok: false; reason: 'covered'; by: string }
    | { ok: false; reason: 'wrong_frame'; by: string };

  if (hit.ok) {
    return;
  }
  const prefix = `候选人 ${name} 的点击坐标（${Math.round(point.x)},${Math.round(point.y)}）在父页被拦下`;
  switch (hit.reason) {
    case 'no_hit':
      throw new Error(`${prefix}：该点上没有任何元素。`);
    case 'covered':
      throw new Error(`${prefix}：被「${hit.by}」遮挡（父页可能还有未关闭的浮层）。`);
    case 'wrong_frame':
      throw new Error(`${prefix}：命中的是「${hit.by}」而非推荐 iframe。`);
    default: {
      const _x: never = hit;
      throw new Error(`${prefix}：未知原因 ${String(_x)}`);
    }
  }
}

/**
 * 第三道：点击派发之后，按 geekId 复查这个人的按钮是否已不可再打招呼。
 *
 * 直接复用调用方已经读到的 `after` 列表，不额外跑 evaluate。必须在付费墙判定**之后**调用，
 * 否则「付费墙拦住了打招呼」会被误报成「坐标落空」，掩盖真正的根因。
 *
 * 校验不过一律抛错、不重试：这一步之前点击已经派发出去了，自动重试可能重复消耗配额。
 */
export function assertGreetTookEffect(
  after: RecommendCandidate[],
  target: { name: string; geekId: string },
): void {
  const card = target.geekId
    ? after.find((c) => c.geekId === target.geekId)
    : after.find((c) => c.name === target.name);
  if (!card) {
    throw new Error(
      `已向 ${target.name} 派发点击，但刷新后列表里找不到这张卡片，无法确认是否发出。`
        + '请在网页上人工核对后再决定是否重试（重试可能重复消耗配额）。',
    );
  }
  if (card.canGreet) {
    throw new Error(
      `已向 ${target.name} 派发点击，但其“打招呼”按钮仍可点击，判定未生效`
        + '（坐标落空或被遮挡）。配额通常未被消耗，请人工核对后再重试。',
    );
  }
}

export function markGreetProduced(
  before: RecommendCandidate[],
  after: RecommendCandidate[],
): void {
  const beforeIds = new Set(before.map((x) => x.geekId).filter(Boolean));
  after.forEach((x) => {
    if (x.geekId && !beforeIds.has(x.geekId)) {
      sessionGreetProducedGeekIds.add(x.geekId);
    }
  });
}

/**
 * 在推荐 iframe 内根据姓名打开在线简历预览：点击候选人卡片主体 `.card-inner`（与侧栏「打招呼」分离）。
 * 父页随后出现 `c-resume` iframe（如 `source=recommend`）。
 *
 * 点击目标就是枚举用的锚点本身——卡片根是由锚点 `closest()` 上溯得到的，锚点必然存在。
 * 上一版在这里还留了「a.resume-btn-online / a[href*=c-resume] / 文案含『在线简历』的链接」
 * 三级兜底，那是为「旧版卡片只有链接、没有 card-inner」准备的；改成锚点枚举后这些分支
 * 永远不可达（没有 `.card-inner[data-geekid]` 的卡片根本不会进 `cards`），已删除。
 */
export async function openRecommendResumePreview(frame: Frame, target: string): Promise<boolean> {
  const raw = target.trim();
  const targetLiteral = JSON.stringify(raw);
  const opened = (await frame.evaluate(`(() => {
    ${RECOMMEND_CARD_ENUM_JS}
    const raw = ${targetLiteral};
    if (cards.length === 0) return false;
    const targetCard = cards.find((root) => {
      const name = __nameOf(root);
      return name === raw || name.includes(raw);
    }) ?? null;
    if (!targetCard) return false;

    const anchor = __anchorOf(targetCard);
    if (!(anchor instanceof HTMLElement)) return false;
    anchor.scrollIntoView({ block: "center", inline: "nearest" });
    anchor.click();
    return true;
  })()`)) as boolean;
  if (opened) {
    await sleepRandom(RESUME_PREVIEW_OPEN_GAP_MS.min, RESUME_PREVIEW_OPEN_GAP_MS.max);
  }
  return opened;
}

export async function runRecommend(jobKeyword?: string): Promise<string> {
  try {
    return await withBossSessionPage(async (page) => {
      const frame = await ensureInRecommendPage(page);
      const selectedJob = await selectRecommendJob(frame, (jobKeyword ?? '').trim());
      const candidates = await readRecommendList(frame);
      const title = selectedJob ? `当前岗位：${selectedJob}` : '当前岗位：默认';
      return [title, '', renderRecommendList(candidates)].join('\n');
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`读取推荐列表失败：${message}`);
  }
}

