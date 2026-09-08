---
name: boss-frontend-analysis
description: Capture, archive, diff, and assess Boss/Zhipin frontend JavaScript AND DOM selectors for boss-cli safety gates, anti-debug guard updates, and selector health monitoring. Use when Codex needs to re-analyze current Boss frontend scripts, validate DOM selectors, compare online JS with docs/research/boss-online-js baselines, update boss_availability, or recommend code changes after Boss changes zhipin-boss, zhipin-sign, risk-detection, remoteEntry, or security scripts.
---

# Boss Frontend Analysis

Use this skill when Boss online frontend assets changed and boss-cli must decide whether to stay disabled, update the verified baseline, or change page guards.

## Scripts

### 1. JS 资源捕获 (`capture_boss_frontend.mjs`)

HTTP 下载 Boss 前端 JS 文件，归档版本和哈希，用于离线分析。

```bash
node skills/boss-frontend-analysis/scripts/capture_boss_frontend.mjs [--date YYYY-MM-DD] [--force]
```

**⚠️ 安全等级: 中等** — 会发出 HTTP 请求下载 JS 文件（与正常浏览器行为一致，但有额外网络流量）。

输出: `docs/research/boss-online-js/<date>/`
- `manifest.json`: URL、大小、SHA-256 哈希、来源分类
- `analysis.md`: 版本变化、高风险脚本说明、代码修改建议
- `raw/`: 原始脚本文件（用于 diff）

### 2. DOM Selector 健康检测 (`check_dom_selectors.mjs`)

连接 boss-cli 已打开的浏览器，只读检测 `recommend.ts`（推荐页）与 `list.ts` / `chat.ts`（沟通页）
里的 selector 是否仍然有效。需 Node >= 22（用内置 WebSocket），且**必须在跑 boss-mcp 的那台机器上执行**。

```bash
# 基本检测（auto：优先推荐页，其次沟通页）
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs

# 指定查哪个页面
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --page chat
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --page recommend

# 保存结构快照（供后续 diff）
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --snapshot

# 与上次快照对比差异
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --diff

# 指定调试端口（默认 53470）
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --port 53470
```

**判定规则**（避免假红）：

- selector 按页面分组，只对「当前页面适用」的那一组判死活；另一组标 ⏭️ 跳过、不计入退出码
- 「按状态才出现」的元素（`hasViewed` / `emptyWorkExp` / 沟通记录弹窗 / 未读角标）标 ℹ️，缺失不算失效
- **逐卡统计「打招呼」按钮**：只看全局数量会掩盖「某个候选人这张卡没有按钮」——
  报告会列出没有按钮的卡片，并给出按钮区里实际的 class 与文案，用来区分
  「业务状态（如「继续沟通」）」和「结构变了（按钮区为空或整块缺失）」

**✅ 安全等级: 极高（零风险）**

| 安全维度 | 说明 |
|---------|------|
| 网络层 | ❌ 不发送任何 HTTP/WebSocket 请求到 Boss 服务器 |
| 执行方式 | CDP 本地通信，等同用户在 DevTools Console 执行代码 |
| DOM 操作 | 纯只读 `querySelectorAll`，不修改任何节点 |
| 事件触发 | 不触发 click/scroll/input/focus 等任何用户事件 |
| 页面导航 | 不 navigate、不 reload、不打开新 tab |
| 时间特征 | 一次性执行完退出，无周期性行为 |

**前提条件**: boss-cli 浏览器已启动且推荐页已加载（运行过 `boss_recommend` 即可）。

**输出**（`docs/research/dom-snapshots/<date>/`，加 `--snapshot` 时）:
- `snapshot.json`: 完整数据（含逐卡按钮统计）
- `classes.txt`: class 名列表（便于 diff）
- `report.txt`: 可读报告
- `card.html`: 第一张推荐卡片的 outerHTML
- `card-missing-greet.html`: 没有「打招呼」按钮的那张卡（存在时才写）
- `chat-row.html`: 聊天列表首行的 outerHTML（存在时才写）

**退出码**:
- `0`: 当前页面适用的 selector 全部正常
- `2`: 当前页面适用的 selector 有失效（需要更新 `recommend.ts` / `list.ts` / `chat.ts`）

### 3. 锚点看守 / 定时检测 + 候选推导 (`selector_watch.mjs`)

无人值守版本。与上面第 2 个脚本的**唯一**安全差别：它**会自己开一个标签并导航**到要检查的
页面——因为定时任务不能假设某个页面正好开着。上一版靠「当前页面」判定，
结果职位管理页从来没被检查过，而真正坏掉的恰好就是它。

**常驻标签（不要改回「每轮开关」）**：`boss_page_guards.ts` 注册了 `targetcreated`，
浏览器里每新建一个标签，boss-mcp 都会对它注入两段脚本并建一次 CDP session。
第一版每轮新建再关闭，等于每轮都逼服务对一个即将消失的标签做注入——实测那段时间用户的
打招呼连续报 `Page.addScriptToEvaluateOnNewDocument timed out`，时间窗口对得上。
现在常驻一个标签，注入只在首次创建时发生一次，之后每轮只是导航。

标签靠 URL hash `#boss-selector-watch` 识别（比记 targetId 简单，也不用碰 puppeteer 私有字段，
而且人在浏览器里能看出这标签是谁开的）。跑完停靠在 `https://www.zhipin.com/favicon.ico#boss-selector-watch`——
这个地址是两次踩坑定下来的：停在推荐页会让常驻标签自己变成僵死候选，下一轮直接
`Network.enable timed out`；停在 `about:blank` 会命中 `RISK_NAVIGATION_RE`，被服务的
framenavigated 守卫导航到 `/web/chat/index`，hash 标记被冲掉、每轮新建一个，标签越积越多。

`acquireWatchTab` 用 `browser.targets()` 而不是 `browser.pages()`：后者会挨个 attach 所有标签、
对每个发 `Network.enable`，**任何一个标签僵死都会把整个调用拖死**（实测就是这么炸的）。

```bash
# 采基线（务必在代码已验证可用时采，这是整套机制的判定依据）
node skills/boss-frontend-analysis/scripts/selector_watch.mjs --baseline

# 日常检测（定时任务跑的就是这个）
node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check

# 用今天已确认失效的旧选择器自测整条链路
node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check --selftest row
node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check --selftest field

# 允许自动改常量（默认不开；定时任务也不传）
node skills/boss-frontend-analysis/scripts/selector_watch.mjs --check --apply
```

**判定分级**（在 `REGISTRY` 里逐锚点声明，四项缺一不可）：

| 字段 | 含义 |
|------|------|
| `kind` | `structural-oracle`（页面自带计数可交叉校验）/ `value-baseline`（靠复现基线值证明等价）/ `shape-only`（只能校验形状，够检测不够自动修） |
| `usage` | `read` / `read+click` / `click`。**必须按实际调用点审计填写**，不能按文件或函数名想当然 |
| `autofix` | 是否允许自动改。`usage` 含 `click` 的一律 `false` |
| `constName` | 源码里对应的选择器常量。没有就只能报告——改 `evaluate` 字符串里的内联字面量等于对源码做正则替换，不做 |

**自动更新的四个前提，缺一不可**：白名单允许 + 调用点纯读 + 候选唯一 + 候选完全复现基线。
指向同一批元素的不同拼法（`.base-label` / `div.base-label` / `.job-labels .base-label`）
会归并成一条并记下别名，不算歧义；只有指向**不同元素集**的候选才算真歧义，那种情况交给人。

**级联折叠**：行容器失效时，行内锚点的 `found=0` 是级联结果而不是独立故障，报告里标 `cascade`
且不计入失效数。不折叠的话一次行容器改名会报出 7 条失效，真因被噪声埋掉。

**日志**（字段固定，便于长期累积分析）：
- `~/.boss-cli/logs/selector-watch.jsonl` — 每锚点一条，关键三字段分开记：
  `triggered`（是否触发）/ `acquired`（是否真正推出可用候选）/ `updated`（是否真正落地更新）。
  混成一个「成功/失败」就看不出瓶颈在哪一环，也无法判断这套机制值不值得继续投入。
- `~/.boss-cli/logs/selector-watch/<run>.txt` — 人读报告
- `~/.boss-cli/logs/selector-watch/cron.log` — 定时任务的 stdout

**基线**：`docs/research/selector-watch/baseline/<page>.json`。
`structuralOnly` 的页面（推荐页）**一律不存值**——卡片文本是真实候选人的姓名、年龄、
期望薪资、工作经历摘要，属于第三方个人信息，不能进仓库；而那页只做结构不变量断言，本来也用不到值。

**两个内置保护**：
- 审计日志 10 分钟内有写入就跳过本轮（`--ignore-busy` 可绕过）。同一个 Chrome 上并发两个
  CDP 客户端会把 boss-mcp 持有的连接搞坏，之后每次调用十几毫秒内失败且不自愈，只能重启服务。
- 落到登录页就报「无法检测」而不是「锚点失效」。分不清这两者的监控会天天误报，误报几次就没人看了。

**定时任务**：`run_selector_watch.cmd`（ASCII-only + CRLF，原因见 `.gitattributes`），
已在 108 注册为 `boss-selector-watch`，每日 03:30，只跑 `--check`，不传 `--apply`。

**退出码**: `0` 全部正常 / `2` 有锚点失效 / `3` 本轮跳过（忙、未登录、浏览器不可用）/ `1` 脚本自身出错

## Workflow（完整检测流程）

### A. 日常维护（推荐频率：每周一次或 Boss 更新后）

1. 启动 boss-cli，确保推荐页已加载
2. 运行 DOM 检测并保存快照:
   ```bash
   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --snapshot --diff
   ```
3. 如果有 selector 失效:
   - 查看报告中的 `allClasses` 列表，寻找新 class 名
   - 对比 `classes.txt` 的 diff 找出变化
   - 更新 `src/toolset/recommend.ts` 中的 selector

### B. 版本升级分析（Boss 大版本更新时）

1. 运行 JS 资源捕获:
   ```bash
   node skills/boss-frontend-analysis/scripts/capture_boss_frontend.mjs
   ```
2. 对比 `docs/research/boss-online-js/` 下新旧 baseline
3. 检查这些文件是否需要更新:
   - `src/common/boss_availability.ts` — 版本号和哈希
   - `src/common/boss_page_guards.ts` — 拦截规则
4. 运行 DOM 检测确认 selector 兼容性:
   ```bash
   node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --snapshot
   ```

## 监控的 Selector 清单

完整清单在脚本的 `SELECTOR_GROUPS` 里，改 selector 时两边要同步。

推荐页（`src/toolset/recommend.ts`）关键项：

| 字段 | Selector | 用途 |
|------|----------|------|
| cardRoot | `.candidate-card-wrap` | 候选人卡片容器 |
| cardInner | `.card-inner` | 卡片内容区域（点击目标） |
| geekId | `.card-inner[data-geekid]` | 候选人 ID |
| name | `.name-wrap .name` | 姓名 |
| salary | `.salary-wrap span` | 薪资 |
| baseInfo | `.base-info span` | 基本信息 |
| workExps | `.col-3 .timeline-wrap.work-exps .timeline-item` | 工作经历 |
| eduWrap | `.edu-wrap` | 教育经历 |
| greetBtn | `.button-chat-wrap .btn.btn-greet` | 打招呼按钮 |
| buttonArea | `.button-chat-wrap` | 按钮区（判断按钮缺失是状态还是结构） |
| jobSelector | `.job-selecter-wrap .ui-dropmenu-label` | 岗位切换 |

沟通页（`src/toolset/list.ts` + `src/toolset/chat.ts`）关键项：

| 字段 | Selector | 用途 |
|------|----------|------|
| rowWrap / row | `.geek-item-wrap` / `.geek-item` | 聊天列表行（定位与点击目标） |
| rowName | `.geek-name` | 候选人姓名（`boss_open_chat` 按姓名查找） |
| sourceJob / pushText / rowTime | `.source-job` / `.push-text` / `.time` | 行内信息 |
| unreadBadge | `.badge-count` | 未读角标 |
| detailContainer / detailName | `.base-info-single-container` / `.name-box` | 右侧详情与姓名校验 |
| historyPanel / historyRecord | `.chat-history-process` / `.record` | 沟通记录弹窗（打开后才存在） |

## Policy（安全策略）

- **DOM 检测永远不发网络请求** — 只连接本地 CDP 端口
- **不在运行时自动检测** — 只能手动运行
- **不修改任何页面内容** — 纯只读操作
- Do not add fallback or bypass switches for availability checks
- If online entry pages reference unverified Boss JS versions, boss-cli must remain disabled
- Only update `boss_availability.ts` after raw scripts are archived and the risk strategy has been reviewed
- Puppeteer `page.evaluate` / `page.waitForFunction` additions must use string scripts, not callback functions

## Analysis Checklist

- Chat entry page: identify current `zhipin-boss/index/v*/static/js/app.js`, `polyfill.js`, and `risk-detection.js`
- Remote bundle: identify current `zhipin-boss/bundle/v*/static/remoteEntry.js` and downloaded chunks
- Sign/login page: identify `zhipin-sign/v*/static/js/app.*.js`, `iframe-core.*.js`, and `vendors~app.*.js`
- Security scripts: note `zhipin-security`, `browser-check`, Warlock, APM, MQTT, and reporting SDK version changes
- Risk detector: search for codes such as `99001`, `99002`, `99004`, `99005`, `srcdoc`, `MutationObserver`, `isTrusted`, `sendAction`, and security redirects
- Sign vendor anti-debug: search for `debugger`, `Function(`, `constructor`, `setInterval`, `console`, `devtools`, and obfuscated modules around those hits
- Guard coverage: verify request-blocking patterns in `boss_page_guards.ts` still cover risk scripts and security redirects
- **DOM selectors**: verify all selectors in `recommend.ts` still match live DOM structure
