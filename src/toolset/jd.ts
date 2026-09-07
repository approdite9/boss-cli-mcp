import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sleepRandom } from '../browser/index.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { clickBossSidebarMenuToPath } from '../common/boss_sidebar_nav.js';
import { JD_DIR } from '../config.js';
import type { Frame, Page } from 'puppeteer-core';

export type ListOpenPositionsDeps = {
  settleWaitMsMin?: number;
  settleWaitMsMax?: number;
  detail?: boolean;
  detailName?: string;
  projectDir?: string;
  detailWaitMs?: number;
};

const BOSS_CHAT_JOB_LIST_URL = 'https://www.zhipin.com/web/chat/job/list';
const JD_PAGE_SETTLE_MS = { min: 3200, max: 5600 } as const;
const JD_DETAIL_DEFAULT_WAIT_MS = 10_000;

/**
 * 职位列表的 DOM 锚点。列表不在主文档里，而在 iframe `/web/frame/job_v2/list` 中；
 * Boss 把该页重写成新的 Vue 组件后，行容器、标题、标签、编辑入口的类名全变了，
 * 旧选择器恒命中 0 个元素：
 *
 *   `.job-jobInfo-warp`            → `li.job-item-container`
 *   `.job-title a`                 → `.job-title .job-name`
 *   `.job-title .label-common`     → `.job-title .base-label`
 *   `.position-edit`               → `.operation-container .operate-btn`（文案「编辑」）
 *
 * 行内的 `.job-status-wrapper .status-box`、`.info-labels span`、
 * `.job-about-num-wrapper .inner-box .num` 没变，继续沿用。
 *
 * 这些选择器被读列表和点编辑两处共用，抽成常量是为了避免只改一处造成漂移——
 * 上一次就是「读列表」的选择器过期后没人发现，因为工具照旧返回成功。
 */
const JOB_ROW_SELECTOR = 'li.job-item-container';
const JOB_TITLE_SELECTOR = '.job-title .job-name';
const JOB_LABEL_SELECTOR = '.job-title .base-label';
const JOB_OPERATE_BTN_SELECTOR = '.operation-container .operate-btn';
const JOB_EDIT_BTN_TEXT = '编辑';

/**
 * 编辑面板的 DOM 锚点。面板不在列表那个 iframe 里——点「编辑」会新开一个 iframe
 * `/web/frame/job/publish-edit`，Boss 把这张表单同样重写了：
 *
 *   `.job-edit-container.edit-job`        → `.job-edit-container`（`edit-job` 这个类没了）
 *   `.form-row` / `.title` / `.content`   → `.publish-edit-form-row` / `.publish-title` / `.publish-content`
 *   `.job-skill-content .job-skill-item`  → `.job-skill-content .selected-skill-item`
 *   `.performance-row textarea`           → `.textarea-container textarea`
 *
 * 字段值统一按「行标题」取，不给每个字段单独写深层结构路径：标题是页面上给人看的文案，
 * 比 `.scope-selecter .scope-select .ui-select-selected-value` 这种路径稳定得多，
 * Boss 调整布局时不容易一起失效。标题里的中文带对齐空格（实测是「公 司」），
 * 所以匹配前把全部空白去掉再比。
 */
const JD_PANEL_ROOT_SELECTOR = '.job-edit-container';
const JD_PANEL_TITLE_SELECTOR = '.publish-title';
const JD_PANEL_CONTENT_SELECTOR = '.publish-content';
const JD_PANEL_SKILL_SELECTOR = '.job-skill-content .selected-skill-item';
const JD_PANEL_DESCRIPTION_SELECTOR = '.textarea-container textarea';
/**
 * 点编辑页左上角的返回箭头，退出编辑面板。
 *
 * 原先把查找范围限定在 `.top-nav` 里（`.top-nav .history-back-container .back-btn`）。
 * 新版编辑页 `.top-nav` 仍然存在，但返回容器已经不在它内部了，于是恒定找不到按钮：
 * 详情读完后关不掉面板，主标签被留在 `/web/chat/job/edit`，只留一条 warning。
 * 这里改成从 document 找 `.history-back-container .back-btn`，不再假设它挂在哪个祖先下。
 */
const CLICK_JD_BACK_BUTTON_SCRIPT = `(() => {
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const backBtn = document.querySelector(".history-back-container .back-btn");
  if (!(backBtn instanceof HTMLElement)) {
    return "no-back-btn";
  }
  if (!(backBtn.querySelector("i.iboss-right") instanceof HTMLElement)) {
    return "no-arrow-icon";
  }
  if (!isVisible(backBtn)) {
    return "back-btn-hidden";
  }
  backBtn.scrollIntoView({ block: "center", inline: "nearest" });
  backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  backBtn.click();
  return "ok";
})()`;

function isBossChatJobListUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zhipin.com')) {
      return false;
    }
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return p === '/web/chat/job/list';
  } catch {
    return false;
  }
}

type JobListItem = {
  title: string;
  label: string;
  status: string;
  meta: string[];
  viewed: string;
  chatted: string;
  interested: string;
};

type JobReadState = {
  rows: number;
  totalText: string;
  title: string;
  url: string;
  bodyPreview: string;
};

type JobReadResult = JobReadState & {
  jobs: JobListItem[];
};

type JobListContext = {
  frame: Frame;
  data: JobReadResult;
  fromFrame: boolean;
  frameUrl: string;
  mainState: JobReadState;
};

type JobDetail = {
  pageTitle: string;
  pageUrl: string;
  company: string;
  recruitmentType: string;
  jobName: string;
  description: string;
  overseas: string;
  jobCategory: string;
  experience: string;
  education: string;
  salaryRange: string;
  salaryMonths: string;
  keywords: string;
  workLocation: string;
};

function resolveTargetJob(jobs: JobListItem[], detailInput: string): JobListItem | null {
  const raw = detailInput.trim();
  if (!raw) return null;
  // 新版页面不再暴露职位 id，职位身份只有标题。所以重名必须在这里就拦下：
  // 若两个职位同名，`find` 会静默返回第一个，用户拿到的 JD 可能是另一个职位的。
  const exactMatches = jobs.filter((job) => job.title === raw);
  if (exactMatches.length > 1) {
    throw new Error(
      `有 ${exactMatches.length} 个职位的标题都是“${raw}”，而当前页面不提供职位 ID，无法区分。` +
        `请在 Boss 后台把重名职位改成可区分的名称。`,
    );
  }
  if (exactMatches.length === 1) {
    return exactMatches[0] ?? null;
  }

  const needle = raw.toLowerCase();
  const fuzzy = jobs.filter((job) => job.title.toLowerCase().includes(needle));
  if (fuzzy.length === 1) {
    return fuzzy[0] ?? null;
  }
  if (fuzzy.length > 1) {
    const picks = fuzzy
      .slice(0, 8)
      .map((j, idx) => `${idx + 1}. ${j.title}`)
      .join('｜');
    throw new Error(`“${raw}”命中多个职位，请改用更精确名称。候选：${picks}`);
  }

  return null;
}

function stripControlChars(input: string): string {
  return input.replace(/[<>:"/\\|?*]/g, '_');
}

function cacheFileCandidates(projectDir: string, title: string): string[] {
  const exact = path.resolve(projectDir, `${title}.md`);
  const safe = path.resolve(projectDir, `${stripControlChars(title)}.md`);
  if (safe === exact) {
    return [exact];
  }
  return [exact, safe];
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJobsFromFrame(frame: Frame): Promise<JobReadResult> {
  return (await frame.evaluate(
    `(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(JOB_ROW_SELECTOR)}));
      const jobs = rows.map((el) => {
        const statusText = norm(el.querySelector(".job-status-wrapper .status-box")?.textContent);
        const labelText = norm(el.querySelector(${JSON.stringify(JOB_LABEL_SELECTOR)})?.textContent);
        const meta = Array.from(el.querySelectorAll(".job-main-info-wrapper .info-labels span"))
          .map((x) => norm(x.textContent))
          .filter(Boolean);
        const nums = Array.from(el.querySelectorAll(".job-about-num-wrapper .inner-box .num"))
          .map((x) => norm(x.textContent));
        return {
          title: norm(el.querySelector(${JSON.stringify(JOB_TITLE_SELECTOR)})?.textContent),
          label: labelText,
          status: statusText,
          meta,
          viewed: nums[0] || "0",
          chatted: nums[1] || "0",
          interested: nums[2] || "0",
        };
      });
      const totalText = norm(document.querySelector(".total-num")?.textContent);
      const bodyText = norm(document.body?.innerText ?? "");
      return {
        rows: rows.length,
        totalText,
        title: document.title || "",
        url: location.href,
        bodyPreview: bodyText.slice(0, 120),
        jobs,
      };
    })()`,
  )) as JobReadResult;
}

async function readJobsFromPageAnyFrame(
  page: Page,
): Promise<JobListContext> {
  const main = await readJobsFromFrame(page.mainFrame());
  if (main.rows > 0 || main.totalText.length > 0) {
    return {
      frame: page.mainFrame(),
      data: main,
      fromFrame: false,
      frameUrl: main.url,
      mainState: main,
    };
  }

  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) {
      continue;
    }
    try {
      const state = await readJobsFromFrame(frame);
      if (state.rows > 0 || state.totalText.length > 0) {
        return {
          frame,
          data: state,
          fromFrame: true,
          frameUrl: state.url,
          mainState: main,
        };
      }
    } catch {
      // ignore cross-origin / detached frames
    }
  }

  return {
    frame: page.mainFrame(),
    data: main,
    fromFrame: false,
    frameUrl: main.url,
    mainState: main,
  };
}

async function waitForJobRowsReady(
  page: Page,
  timeoutMs: number,
): Promise<JobListContext> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await readJobsFromPageAnyFrame(page);
    // 判就绪只看「解析出了行」。原先是 `rows > 0 || totalText.length > 0`，
    // 只要页面上有「共 N 个职位」这段文字就算通过——行容器选择器过期后，
    // 这里立刻返回 0 行，`boss_list_positions` 照旧以成功收尾输出「已读取 0 个职位」，
    // 真正的失败被推迟到 `boss_get_jd`，报成「未找到职位 XXX」，看不出是列表压根为空。
    // 计数文字只用来定位列表所在 frame（见 readJobsFromPageAnyFrame），不能当成功判据。
    if (state.data.rows > 0) {
      return state;
    }
    await sleepRandom(260, 520);
  }
  const last = await readJobsFromPageAnyFrame(page);
  throw new Error(
    [
      `等待职位列表超时：${JOB_ROW_SELECTOR} 在 ${timeoutMs}ms 内始终为 0 个`,
      `frame.rows=${last.data.rows}`,
      `frame.total="${last.data.totalText}"`,
      `main.rows=${last.mainState.rows}`,
      `main.total="${last.mainState.totalText}"`,
      `main.title="${last.mainState.title}"`,
      `main.url=${last.mainState.url}`,
      `main.body="${last.mainState.bodyPreview}"`,
      `frameHit=${last.fromFrame ? 'yes' : 'no'}`,
      `frame.url=${last.frameUrl}`,
    ].join('；'),
  );
}

async function clickEditForJob(frame: Frame, job: JobListItem): Promise<void> {
  const targetTitle = JSON.stringify(job.title ?? '');
  // 行内不再有 `data-id`（新版只剩 Vue 的 `data-v-*` 作用域标记），身份只能靠标题文本。
  // 标题重名的歧义在 resolveTargetJob 里已经拦下，所以这里按标题精确匹配是安全的。
  // 编辑入口是 `.operation-container` 下文案为「编辑」的 span：同一容器里还有
  // 「关闭」/「打开」，按位置取第一个会在 Boss 调整按钮顺序时点错，所以按文案取。
  const outcome = (await frame.evaluate(
    `(() => {
      const title = ${targetTitle};
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(JOB_ROW_SELECTOR)}));
      if (rows.length === 0) return { ok: false, reason: "no-rows" };
      const matched = rows.filter((el) => {
        const t = norm(el.querySelector(${JSON.stringify(JOB_TITLE_SELECTOR)})?.textContent);
        return t === title;
      });
      if (matched.length === 0) {
        return {
          ok: false,
          reason: "no-title-match",
          seen: rows
            .map((el) => norm(el.querySelector(${JSON.stringify(JOB_TITLE_SELECTOR)})?.textContent))
            .filter(Boolean)
            .slice(0, 8),
        };
      }
      if (matched.length > 1) {
        return { ok: false, reason: "duplicate-title", count: matched.length };
      }
      const row = matched[0];
      const editBtn = Array.from(row.querySelectorAll(${JSON.stringify(JOB_OPERATE_BTN_SELECTOR)}))
        .find((b) => norm(b.textContent) === ${JSON.stringify(JOB_EDIT_BTN_TEXT)});
      if (!(editBtn instanceof HTMLElement)) {
        return {
          ok: false,
          reason: "no-edit-button",
          btns: Array.from(row.querySelectorAll(${JSON.stringify(JOB_OPERATE_BTN_SELECTOR)}))
            .map((b) => norm(b.textContent))
            .filter(Boolean),
        };
      }
      editBtn.scrollIntoView({ block: "center", inline: "nearest" });
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      editBtn.click();
      return { ok: true };
    })()`,
  )) as
    | { ok: true }
    | { ok: false; reason: string; seen?: string[]; btns?: string[]; count?: number };

  if (outcome.ok) {
    return;
  }
  switch (outcome.reason) {
    case 'no-rows':
      throw new Error(
        `点编辑时职位列表已空（${JOB_ROW_SELECTOR} 命中 0 个），页面可能已跳转或重新渲染。`,
      );
    case 'no-title-match':
      throw new Error(
        `列表里没有标题恰好等于“${job.title}”的职位。当前列表：${(outcome.seen ?? []).join('｜') || '（空）'}`,
      );
    case 'duplicate-title':
      throw new Error(
        `列表里有 ${outcome.count} 个职位标题都是“${job.title}”，无法确定要编辑哪一个。请在 Boss 后台把重名职位改成可区分的名称。`,
      );
    case 'no-edit-button':
      throw new Error(
        `找到职位“${job.title}”但其 ${JOB_OPERATE_BTN_SELECTOR} 里没有文案为「${JOB_EDIT_BTN_TEXT}」的按钮。` +
          `实际按钮：${(outcome.btns ?? []).join('｜') || '（无）'}`,
      );
    default:
      throw new Error(`点击职位“${job.title}”的编辑入口失败：${outcome.reason}`);
  }
}

async function readJobDetailFromFrame(frame: Frame): Promise<JobDetail | null> {
  const detail = (await frame.evaluate(
    `(() => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
      // 标题带对齐空格（「公 司」），比对前去掉全部空白
      const keyOf = (v) => (v ?? "").replace(/\\s+/g, "");

      const root = document.querySelector(${JSON.stringify(JD_PANEL_ROOT_SELECTOR)});
      if (!root) {
        return null;
      }
      // 表单还在渲染时 root 已经在了但字段是空的；职位名称是必填项，
      // 它有值才说明表单真的填充完了。返回 null 让调用方继续轮询，而不是产出一份空 JD。
      const jobName = norm(root.querySelector("input[name='jobName']")?.value);
      if (!jobName) {
        return null;
      }

      const rowByKey = {};
      for (const titleEl of Array.from(document.querySelectorAll(${JSON.stringify(JD_PANEL_TITLE_SELECTOR)}))) {
        const k = keyOf(titleEl.textContent);
        if (!k || rowByKey[k]) continue;
        const parent = titleEl.parentElement;
        if (!parent) continue;
        const scope = parent.querySelector(${JSON.stringify(JD_PANEL_CONTENT_SELECTOR)}) || parent;
        rowByKey[k] = {
          text: norm(scope.innerText),
          selected: Array.from(scope.querySelectorAll(".ui-select-selected-value")).map((x) => norm(x.textContent)),
          inputs: Array.from(scope.querySelectorAll("input,textarea")).map((x) => ({
            placeholder: x.getAttribute("placeholder") || "",
            value: norm(x.value),
          })),
          active: norm(scope.querySelector(".chose-item.active")?.textContent),
        };
      }
      const row = (k) => rowByKey[k] || { text: "", selected: [], inputs: [], active: "" };

      const salary = row("薪资范围").selected;
      const location_ = row("工作地址").inputs.find((i) => i.placeholder.includes("工作地点"));
      const keywordValues = Array.from(root.querySelectorAll(${JSON.stringify(JD_PANEL_SKILL_SELECTOR)}))
        .map((el) => norm(el.textContent))
        .filter(Boolean);

      return {
        pageTitle: document.title || "",
        pageUrl: location.href,
        company: row("公司").text,
        recruitmentType: row("招聘类型").selected[0] || "",
        jobName,
        description: norm(root.querySelector(${JSON.stringify(JD_PANEL_DESCRIPTION_SELECTOR)})?.value),
        overseas: row("是否驻外").active,
        jobCategory: norm(root.querySelector("input[name='jobCategory']")?.value),
        experience: row("经验").selected[0] || "",
        education: row("学历").selected[0] || "",
        salaryRange: salary.length >= 2 ? (salary[0] + "-" + salary[1]) : salary.join("-"),
        salaryMonths: salary[2] || "",
        keywords: keywordValues.join("｜"),
        workLocation: location_ ? location_.value : "",
      };
    })()`,
  )) as JobDetail | null;
  return detail;
}

async function waitForJobDetailReady(page: Page, timeoutMs: number): Promise<JobDetail> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      try {
        const detail = await readJobDetailFromFrame(frame);
        if (detail) {
          return detail;
        }
      } catch {
        // ignore detached/cross-origin frame read errors
      }
    }
    await sleepRandom(260, 520);
  }
  throw new Error(
    `等待职位详情表单超时：${timeoutMs}ms 内没有任何 frame 出现 ${JD_PANEL_ROOT_SELECTOR} ` +
      `且 input[name='jobName'] 有值。已探测的 frame：${page
        .frames()
        .map((f) => f.url() || '(about:blank)')
        .join('；')}`,
  );
}

async function closeJobDetailPanel(page: Page, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  let lastReason = 'never-evaluated';
  while (Date.now() - start < timeoutMs) {
    lastReason = (await page.evaluate(CLICK_JD_BACK_BUTTON_SCRIPT)) as string;
    if (lastReason === 'ok') {
      return;
    }
    await sleepRandom(160, 360);
  }

  throw new Error(
    `已读取职位详情，但未能点掉编辑面板的返回按钮（.history-back-container .back-btn > i.iboss-right），` +
      `最后一次原因：${lastReason}。浏览器会停在编辑页 ${page.url()}。`,
  );
}

function formatJobDetailMarkdown(job: JobListItem, detail: JobDetail): string {
  return [
    `# ${job.title}`,
    '',
    `- 状态: ${job.status || '未知'}`,
    `- 标签: ${job.label || '无'}`,
    '',
    '## 基本信息',
    `- 公司: ${detail.company || '未知'}`,
    `- 招聘类型: ${detail.recruitmentType || '未知'}`,
    `- 职位名称: ${detail.jobName || job.title}`,
    `- 职位类型: ${detail.jobCategory || '未知'}`,
    `- 是否驻外: ${detail.overseas || '未知'}`,
    '',
    '## 要求',
    `- 经验: ${detail.experience || '未知'}`,
    `- 学历: ${detail.education || '未知'}`,
    `- 薪资范围: ${detail.salaryRange || '未知'}`,
    `- 薪资月数: ${detail.salaryMonths || '未知'}`,
    `- 关键词: ${detail.keywords || '无'}`,
    `- 工作地点: ${detail.workLocation || '未知'}`,
    '',
    '## 职位描述',
    detail.description || '（空）',
    '',
  ].join('\n');
}

export async function runListOpenPositions(
  deps: ListOpenPositionsDeps = {},
): Promise<string> {
  const settleMin = deps.settleWaitMsMin ?? JD_PAGE_SETTLE_MS.min;
  const settleMax = deps.settleWaitMsMax ?? JD_PAGE_SETTLE_MS.max;
  const detailMode = deps.detail === true;
  const detailName = (deps.detailName ?? '').trim();
  const projectDir = deps.projectDir ?? JD_DIR;
  const detailWaitMs = deps.detailWaitMs ?? JD_DETAIL_DEFAULT_WAIT_MS;

  if (detailMode && detailName) {
    const candidates = cacheFileCandidates(projectDir, detailName);
    for (const p of candidates) {
      if (await fileExists(p)) {
        return readFile(p, 'utf8');
      }
    }
  }

  try {
    return await withBossSessionPage(async (page) => {
      const currentUrl = page.url();
      if (!isBossChatJobListUrl(currentUrl)) {
        await clickBossSidebarMenuToPath(page, '职位管理', '/web/chat/job/list');
        await sleepRandom(settleMin, settleMax);
      }
      if (!isBossChatJobListUrl(page.url())) {
        throw new Error('通过侧边栏“职位管理”进入职位页失败，请确认已登录并可访问 /web/chat/job/list。');
      }
      const ready = await waitForJobRowsReady(page, 16_000);
      await sleepRandom(350, 920);

      // 每一行都是一个职位，必然有标题。解析不出标题只可能是标题选择器过期，
      // 用 `.filter(it => it.title)` 把它们滤掉会让结果退化成「读到 0 个职位」并照旧返回成功，
      // 正是这次要修掉的失败模式；这里如实抛错，把行数和标题选择器一起报出来。
      const jobs = ready.data.jobs;
      const untitled = jobs.filter((it) => it.title.length === 0).length;
      if (untitled > 0) {
        throw new Error(
          `职位列表解析到 ${jobs.length} 行，其中 ${untitled} 行读不出标题` +
            `（标题选择器 ${JOB_TITLE_SELECTOR} 可能已失效）。`,
        );
      }
      const jobLines = jobs.map((it, idx) => {
        const info = it.meta.length > 0 ? it.meta.join('｜') : '信息缺失';
        const stats = `看过我:${it.viewed}｜沟通过:${it.chatted}｜感兴趣:${it.interested}`;
        const tag = it.label ? `｜标签:${it.label}` : '';
        return `${idx + 1}. ${it.title}｜状态:${it.status || '未知'}${tag}｜${info}｜${stats}`;
      });
      const details = jobLines.length > 0 ? jobLines.join('\n') : '当前页面未读取到职位。';
      const openCount = jobs.filter((it) => it.status.includes('开放中')).length;
      const waitOpenCount = jobs.filter((it) => it.status.includes('待开放')).length;
      const closedCount = jobs.filter((it) => it.status.includes('已关闭')).length;
      const totalText = ready.data.totalText ? `（页面统计：${ready.data.totalText}）` : '';

      if (!detailMode) {
        return [
          `已读取 ${jobs.length} 个职位${totalText}。`,
          `状态统计：开放中 ${openCount}｜待开放 ${waitOpenCount}｜已关闭 ${closedCount}`,
          `来源页面：${BOSS_CHAT_JOB_LIST_URL}`,
          `职位明细：\n${details}`,
        ].join('\n');
      }
      const targetJob = resolveTargetJob(jobs, detailName);
      if (!targetJob) {
        const available = jobs.slice(0, 8).map((j) => j.title).join('｜');
        throw new Error(
          `未找到职位“${detailName}”（支持名称和模糊匹配）。可选职位：${available || '（空）'}`,
        );
      }
      const candidates = cacheFileCandidates(projectDir, targetJob.title);
      const listCtx = await waitForJobRowsReady(page, 16_000);
      await clickEditForJob(listCtx.frame, targetJob);
      await sleepRandom(detailWaitMs, detailWaitMs);
      const detail = await waitForJobDetailReady(page, 12_000);
      const outPath = candidates[candidates.length - 1]!;
      const markdown = formatJobDetailMarkdown(targetJob, detail);
      await writeFile(outPath, markdown, 'utf8');
      try {
        await closeJobDetailPanel(page);
      } catch (closeError) {
        const msg = closeError instanceof Error ? closeError.message : String(closeError);
        console.warn(`[boss-cli] jd detail close warning: ${msg}`);
      }
      return markdown;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[boss-cli] list_open_positions error: ${message}`);
    throw new Error(`获取岗位列表失败：${message}`);
  }
}
