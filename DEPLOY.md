# boss-cli-CloakBrowser 部署指南

## 一键部署（新机器）

### Windows

```powershell
# 1. 复制项目
xcopy /E /I "C:\Users\60230\Desktop\test\boss-cli-main-CloakBrowser" "D:\boss-cli-cloak"
cd D:\boss-cli-cloak

# 2. 安装依赖 + CloakBrowser 二进制
npm install
node node_modules\cloakbrowser\dist\cli.js install

# 3. 首次登录（有头，扫码）
set BOSS_BROWSER_ENGINE=cloakbrowser
set CLOAKBROWSER_FINGERPRINT_SEED=42857
node dist\cli\index.js login

# 4. 验证
node test_quick.mjs
```

### Linux

```bash
# 1. 复制项目（不含 node_modules）
scp -r boss-cli-main-CloakBrowser/ user@server:~/boss-cli-cloak/
cd ~/boss-cli-cloak

# 2. 安装
npm install
node node_modules/cloakbrowser/dist/cli.js install

# 3. 首次登录（需要 DISPLAY 或 xvfb）
export BOSS_BROWSER_ENGINE=cloakbrowser
export CLOAKBROWSER_FINGERPRINT_SEED=42857
export DISPLAY=:0  # 或 xvfb-run
node dist/cli/index.js login

# 4. 之后可无头运行
export BOSS_BROWSER_HEADLESS=true
```

---

## MCP 配置

### 本地 Windows（有头）

```json
{
  "mcpServers": {
    "boss-cloak": {
      "command": "node",
      "args": ["C:\\Users\\60230\\Desktop\\test\\boss-cli-main-CloakBrowser\\dist\\mcp\\server.js"],
      "disabled": false,
      "env": {
        "BOSS_BROWSER_ENGINE": "cloakbrowser",
        "CLOAKBROWSER_FINGERPRINT_SEED": "42857",
        "BOSS_ALIYUN_ACCESS_KEY_ID": "<你的KEY>",
        "BOSS_ALIYUN_ACCESS_KEY_SECRET": "<你的SECRET>"
      }
    }
  }
}
```

### Linux 服务器（无头）

```json
{
  "mcpServers": {
    "boss-cloak": {
      "command": "node",
      "args": ["/home/user/boss-cli-cloak/dist/mcp/server.js"],
      "disabled": false,
      "env": {
        "BOSS_BROWSER_ENGINE": "cloakbrowser",
        "BOSS_BROWSER_HEADLESS": "true",
        "CLOAKBROWSER_FINGERPRINT_SEED": "42857",
        "DISPLAY": ":0",
        "BOSS_ALIYUN_ACCESS_KEY_ID": "<你的KEY>",
        "BOSS_ALIYUN_ACCESS_KEY_SECRET": "<你的SECRET>"
      }
    }
  }
}
```

---

## 环境变量完整参考

| 变量 | 必选 | 默认值 | 说明 |
|------|------|--------|------|
| `BOSS_BROWSER_ENGINE` | ✅ | — | 设为 `cloakbrowser` 启用隐身模式 |
| `CLOAKBROWSER_FINGERPRINT_SEED` | 推荐 | 随机 | 固定种子保持登录态（不设会每次换身份） |
| `BOSS_BROWSER_HEADLESS` | 否 | `false` | 无头模式（CloakBrowser 版专属） |
| `CLOAKBROWSER_BINARY_PATH` | 否 | 自动探测 | 手动指定二进制路径 |
| `CLOAKBROWSER_TIMEZONE` | 否 | `Asia/Shanghai` | 浏览器时区 |
| `CLOAKBROWSER_LOCALE` | 否 | `zh-CN` | 浏览器语言 |
| `CLOAKBROWSER_LICENSE_KEY` | 否 | Free | Pro 版许可证 |
| `BOSS_BROWSER_REMOTE_DEBUGGING_PORT` | 否 | `53470` | CDP 远程调试端口 |
| `BOSS_RESUME_SCREENSHOT_VIEWPORT_HEIGHT` | 否 | `5000` | 简历截图视口高度(px) |
| `BOSS_ALIYUN_ACCESS_KEY_ID` | 否 | — | 阿里云 OCR Key |
| `BOSS_ALIYUN_ACCESS_KEY_SECRET` | 否 | — | 阿里云 OCR Secret |

---

## 迁移核心文件清单

只需这些文件就能在新机器部署：

```
必须：
├── src/                  ← 全部源码
├── scripts/              ← setup-mcp.mjs 等
├── skills/               ← Agent 技能描述
├── package.json
├── package-lock.json
├── tsconfig.json
├── .env.cloakbrowser     ← 配置模板
└── docs/CLOAKBROWSER_INTEGRATION.md

不需要：
├── boss-cli-main/        ← 嵌套副本（删）
├── boss-cli.tar.gz       ← 原始打包（删）
├── _retired/             ← 废弃代码（删）
├── _ssh.mjs              ← 工具脚本（删）
├── landing/              ← 官网代码（删）
├── test_*.mjs            ← 调试脚本（删）
├── node_modules/         ← npm install 重建
└── dist/                 ← npm run build 重建
```

---

## 从原版 boss-cli-mcp 迁移

如果你已有 `approdite9/boss-cli-mcp` 在 Linux 上运行：

```bash
# 1. 备份原版
mv ~/dev/boss-cli-mcp ~/dev/boss-cli-mcp.bak

# 2. 部署 CloakBrowser 版
cp -r boss-cli-main-CloakBrowser ~/dev/boss-cli-cloak
cd ~/dev/boss-cli-cloak
npm install
node node_modules/cloakbrowser/dist/cli.js install  # 下载 Linux 二进制 (~535MB)
npm run build

# 3. 复用原有登录态
cp -r ~/dev/boss-cli-mcp.bak/.boss-cli ~/.boss-cli 2>/dev/null || true

# 4. 更新 MCP 配置中的路径
# args: ["/home/user/dev/boss-cli-cloak/dist/mcp/server.js"]
# 添加 env.BOSS_BROWSER_ENGINE = "cloakbrowser"

# 5. 重新登录（建议，因为指纹变了）
export BOSS_BROWSER_ENGINE=cloakbrowser
export CLOAKBROWSER_FINGERPRINT_SEED=42857
node dist/cli/index.js login
```

---

## 登录态持久化注意事项

登录态由两个因素绑定：
1. `~/.boss-cli/.cache/browser-data/` — Cookie + LocalStorage
2. `CLOAKBROWSER_FINGERPRINT_SEED` — 设备指纹

**规则**：
- seed 不变 + browser-data 不清 → 登录态持久（数天~数周）
- seed 变了 → Boss 认为是新设备 → 需要重新登录
- browser-data 被清 → Cookie 丢失 → 需要重新登录

**迁移时**打包这两个东西：
```bash
tar czf boss-session.tar.gz ~/.boss-cli/.cache/browser-data/
# 到新机器解压后，用同一个 CLOAKBROWSER_FINGERPRINT_SEED
```

---

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `未找到 CloakBrowser 隐身浏览器二进制` | 未安装 | `node node_modules/cloakbrowser/dist/cli.js install` |
| `[boss-mcp] ❌ 拒绝启动：无头模式` | 未设置 ENGINE | 添加 `BOSS_BROWSER_ENGINE=cloakbrowser` |
| 登录态频繁丢失 | seed 每次随机 | 设固定 `CLOAKBROWSER_FINGERPRINT_SEED` |
| 深度搜索仍触发风控 | Free 版补丁不够新 | 1) 运行 `cloakbrowser login` 获取最新免费二进制 2) 考虑 Pro |
| Linux 无法启动 Chrome | 无 DISPLAY | `apt install xvfb` + `export DISPLAY=:99` + `Xvfb :99 &` |
| 端口冲突 | 另一个 boss-mcp 占用 53470 | 设置 `BOSS_BROWSER_REMOTE_DEBUGGING_PORT=53471` |
