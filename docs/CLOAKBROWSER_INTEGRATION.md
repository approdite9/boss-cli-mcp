# CloakBrowser 集成指南

## 概述

本分支将 boss-cli 的浏览器引擎从原生 Chrome/Edge 切换为 [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) 隐身 Chromium，通过 71+ 个 C++ 源码级补丁从根本上对抗 Boss 直聘的风控检测。

## 为什么需要 CloakBrowser

Boss 直聘的 aegis 风控系统检测维度包括：
- **Canvas/WebGL 指纹**：stock Chrome + Puppeteer 的渲染结果暴露自动化特征
- **CDP 信号泄漏**：`navigator.webdriver`、DevTools protocol 连接特征
- **WebRTC IP 泄漏**：代理环境下 ICE candidates 暴露真实 IP
- **console.table 时间差**：CDP 会话序列化延迟被 disable-devtool 捕捉
- **WASM 行为神经网络**：zhipin-sign 内嵌模型分析击键/鼠标轨迹

CloakBrowser 在 Chromium C++ 编译层面解决以上所有问题，不是 JS 注入。

## 快速启动

### 1. 安装 CloakBrowser 二进制

```bash
# 方式 A：通过 npm 安装（会自动下载二进制）
npm install cloakbrowser
npx cloakbrowser login  # GitHub 登录获取 Free 版二进制

# 方式 B：手动下载
# 从 https://cloakbrowser.dev 下载后放入 ~/.cloakbrowser/
```

### 2. 配置环境变量

```bash
# 最简配置 — 只需两行
export BOSS_BROWSER_ENGINE=cloakbrowser
export CLOAKBROWSER_FINGERPRINT_SEED=42857  # 固定种子保持登录态

# 或使用配置文件
cp .env.cloakbrowser .env
```

### 3. 正常使用 boss-cli

```bash
boss login       # 首次登录（打开 CloakBrowser 窗口扫码）
boss search      # 深度搜索 — 现在不会触发风控
boss greet       # 批量打招呼
```

## 环境变量参考

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BOSS_BROWSER_ENGINE` | 设为 `cloakbrowser` 启用隐身模式 | (不启用) |
| `CLOAKBROWSER_BINARY_PATH` | CloakBrowser 可执行文件精确路径 | 自动探测 ~/.cloakbrowser/ |
| `CLOAKBROWSER_CACHE_DIR` | 二进制缓存目录 | ~/.cloakbrowser/ |
| `CLOAKBROWSER_FINGERPRINT_SEED` | 固定指纹种子（保持身份一致） | 每次随机 |
| `CLOAKBROWSER_TIMEZONE` | 浏览器时区 | Asia/Shanghai |
| `CLOAKBROWSER_LOCALE` | 浏览器语言 | zh-CN |
| `CLOAKBROWSER_LICENSE_KEY` | Pro 版许可证 | (Free 版) |

## 注入的隐身参数

当 `BOSS_BROWSER_ENGINE=cloakbrowser` 时，`connectBrowser()` 自动注入：

```
--fingerprint=SEED              # 主指纹种子（Canvas/WebGL/Audio/字体）
--fingerprint-platform=windows  # 平台伪装
--fingerprint-webrtc-ip=auto    # WebRTC IP 伪造
--fingerprint-hardware-concurrency=8
--fingerprint-device-memory=8
--fingerprint-screen-width=1920
--fingerprint-screen-height=1080
--fingerprint-noise             # Canvas/WebGL 渲染噪声
--fingerprint-allow-3p-cookies  # Boss 登录态需要
--fingerprint-timezone=Asia/Shanghai
--fingerprint-locale=zh-CN
--ignore-gpu-blocklist          # GPU 渲染一致性
```

## 关于登录态

**重要**：`CLOAKBROWSER_FINGERPRINT_SEED` 决定了浏览器的"身份"。

- **固定种子**（推荐）：每次启动使用相同指纹，Boss 认为是同一台设备，登录态持久
- **随机种子**：每次启动是"新设备"，可能触发重新登录

设置固定种子后，配合 `--user-data-dir`（boss-cli 默认 `~/.boss-cli/.cache/browser-data`），登录态可长期保持。

## Free vs Pro 对比

| 场景 | Free (v146, 58+补丁) | Pro (v150+, 71+补丁) |
|------|-----|-----|
| Boss 直聘深度搜索 | ⚠️ 可能仍偶尔触发 | ✅ 最新补丁覆盖 |
| reCAPTCHA v3 分数 | ~0.7 | 0.9 |
| Windows GPU 直通 | ❌ 需 --disable-gpu | ✅ 原生 |
| 更新频率 | 偶尔 | 跟随 Chromium 版本 |

建议先用 Free 版测试效果，如仍有风控问题再考虑 Pro。

## 故障排查

### 1. "未找到 CloakBrowser 隐身浏览器二进制"
```bash
# 确认二进制已下载
ls ~/.cloakbrowser/
# 或手动指定路径
export CLOAKBROWSER_BINARY_PATH=/path/to/chrome
```

### 2. 仍然触发验证
- 确认 `[boss-cli] CloakBrowser 隐身模式已启用` 日志已输出
- 设置固定 seed：`CLOAKBROWSER_FINGERPRINT_SEED=12345`
- 操作间隔可能太快：配合 `human_delay.ts` 增加随机等待

### 3. 登录态丢失
- 检查是否每次启动 seed 不同（随机模式会导致 Boss 认为是新设备）
- 设置 `CLOAKBROWSER_FINGERPRINT_SEED` 为固定值

## 架构变更

仅修改 `src/browser/cdp_browser.ts`：
- 新增 `isCloakBrowserEnabled()` — 检测引擎开关
- 新增 `findCloakBrowserExecutable()` — 自动探测二进制路径
- 新增 `getCloakBrowserStealthArgs()` — 生成隐身启动参数
- 修改 `connectBrowser()` — 条件注入隐身参数

**完全向后兼容**：不设置 `BOSS_BROWSER_ENGINE` 时行为与原版完全一致。

---

## 行为层增强（v2 — 2026-08-17）

新增 `src/common/behavior_enhance.ts`，对抗 Boss 直聘服务端行为分析：

### 覆盖的检测维度

| 维度 | 社区确认检测方式 | 本次修复 |
|------|---------------|---------|
| `performance.now` 时序探针 | CDP 序列化延迟被检测 | ✅ Hook 为 Date.now 基准递增值 + 微抖动 |
| 鼠标轨迹 | WASM 神经网络分析轨迹是否为人 | ✅ 三次贝塞尔曲线 + ease-in-out + 随机抖动 |
| 键盘 IME 事件 | 缺少 compositionstart/update/end | ✅ 完整 IME 事件流 + VK_PROCESSKEY |
| 输入法标志位 | "未通过输入法输入中文" | ✅ 由 IME 事件流解决 |
| zhipin-sign WASM | 内嵌行为分析神经网络 | ✅ 拦截 .wasm 文件（保留 stoken 生成） |
| console 时间差 | 对象序列化耗时比对 | ✅ 已有（sanitizeArgs） |

### 新增 API

```typescript
import {
  humanMouseMove,      // 贝塞尔曲线鼠标移动
  humanClick,          // 拟人点击（移动+按下+抬起）
  humanClickSelector,  // 对选择器元素拟人点击
  typeChineseWithIME,  // 完整 IME 中文输入（含事件流）
} from './browser/index.js';

// 拟人鼠标移动到坐标
await humanMouseMove(page, 500, 300);

// 拟人点击按钮
await humanClickSelector(page, '.btn-ai-match-v2');

// IME 中文输入（自动拆词上屏 + compositionstart/update/end）
await typeChineseWithIME(page, '3年Java开发经验', 'textarea.condition-input');
```

### performance.now hook 原理

```
原版问题：
  CDP 建立 → console.table(大对象) → inspector 序列化 → performance.now 跳跃 → 被检测

Hook 后：
  performance.now() = Date.now() - timeOrigin + 微抖动
  → 单调递增（不会 t1===t2）
  → 无异常跳跃（不受 CDP 序列化影响）
  → toString() 返回 native code（通过反检测）
```

### zhipin-sign WASM 拦截策略

⚠️ **不能拦截 zhipin-sign 所有请求**（否则 __zp_stoken__ 无法生成 → 所有接口 401）

正确做法：
- ✅ 拦截 `*zhipin-sign*.wasm*` — 行为分析神经网络
- ✅ 拦截 `*zhipin-sign*report*` — 行为数据上报
- ✅ 拦截 `*zhipin-sign*collect*` — 行为数据采集
- ❌ 不拦截 zhipin-sign 的 JS 主体 — stoken 生成依赖它

### 文件变更

```
src/common/behavior_enhance.ts   [新增] 行为层增强模块
src/common/boss_page_guards.ts   [修改] 集成 behavior_enhance
src/browser/index.ts             [修改] 导出新 API
```
