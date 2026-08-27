# 项目协作规则

## 基本原则

- 禁止添加任何回退逻辑（fallback）。
- 禁止添加掩盖根因的“胶水代码”。
- 默认采用单一路径、可预测行为；未经明确要求，不引入隐式分支。

## 失败处理

- 失败应直接暴露，不做静默兜底。
- 错误信息必须清晰、可定位，日志应包含关键上下文。
- 发现问题优先修复根因，不通过绕路方案规避。

## 变更约束

- 小步修改，保持最小必要改动。
- 不在未被要求的范围内扩散改动。
- 规则优先级：用户明确要求 > 本文件约束。

## 文档索引

- 页面 URL、命令功能和当前位置要求记录在 `docs/boss-url-map.md`。
- 修改导航、命令入口、当前位置校验或 help 文案前，先查阅并同步更新该文档。

## Puppeteer evaluate 约束（重要）

- 在工具代码中，避免使用 `page.evaluate(() => { ... })` / `page.waitForFunction(() => { ... })` 的函数写法。
- 统一改为字符串脚本写法（如 `page.evaluate("(() => { ... })()")`），避免构建后注入辅助符号导致浏览器上下文报错 `__name is not defined`。
- 出现 `__name is not defined` 时，优先检查最近新增的 evaluate / waitForFunction 回调并改成字符串脚本，不要加兜底掩盖问题。
- 字符串脚本**必须自执行**（`"(() => { ... })()"`），且参数一律用 `JSON.stringify` 内联进脚本文本。
  puppeteer 对字符串 pageFunction 走 `Runtime.evaluate`，`page.evaluate("((a) => {...})", a)` 这种写法
  **额外参数会被静默丢弃**：`evaluate` 返回未被调用的函数对象序列化后的 `{}`（取字段得 undefined，
  常以 `Input.dispatchMouseEvent ... params.x` 这类无关报错暴露），`waitForFunction` 则因表达式恒为真
  而立刻「等待成功」，校验完全空转。
- `ElementHandle` 需要句柄参与时不要用字符串脚本（拿不到 `el`），改用 puppeteer 原生方法，
  如 `handle.scrollIntoView()` / `handle.clickablePoint()`。
- 跨 frame 操作要认准文档归属：在 iframe（如 `recommendFrame`）里打的标记必须用同一个 `frame` 定位，
  用 `frame.page()` 在顶层 document 里查会永远查不到。

## 空行填充（禁止）

- 禁止提交「真实代码行之间夹大量空行」的文件（历史事故：`behavior_enhance.ts` 18332 行里 17994 行是空行）。
  这类文件会让 review 翻不动、grep 行号失真、按行读取只能拿到空白。
- `npm run build` 前置执行 `scripts/check-blank-padding.mjs`：连续空行 ≥ 5 行，或 200 行以上文件空行占比 ≥ 50%，直接失败。
- 单独体检：`npm run check:blank`。
