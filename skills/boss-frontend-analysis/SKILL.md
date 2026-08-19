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

### 2. DOM Selector 健康检测 (`check_dom_selectors.mjs`) 🆕

连接 boss-cli 已打开的浏览器，只读检测 `recommend.ts` 中所有 selector 是否仍然有效。

```bash
# 基本检测（输出报告到终端）
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs

# 保存结构快照（供后续 diff）
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --snapshot

# 与上次快照对比差异
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --diff

# 指定调试端口（默认 53470）
node skills/boss-frontend-analysis/scripts/check_dom_selectors.mjs --port 53470
```

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

**输出**:
- 终端彩色报告: 每个 selector 的存活状态
- `docs/research/dom-snapshots/<date>/snapshot.json`: 完整数据
- `docs/research/dom-snapshots/<date>/classes.txt`: class 名列表（便于 diff）
- `docs/research/dom-snapshots/<date>/report.txt`: 可读报告

**退出码**:
- `0`: 所有 selector 正常
- `2`: 有候选人卡片但 selector 失效（需要更新 recommend.ts）

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

以下 selector 来自 `src/toolset/recommend.ts`，是 boss-cli 推荐功能的关键依赖：

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
| jobSelector | `.job-selecter-wrap .ui-dropmenu-label` | 岗位切换 |

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
