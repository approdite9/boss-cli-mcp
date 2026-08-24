# Boss-CLI MCP 服务 — 技术交接文档

> 更新时间：2026-08-24  
> 服务版本：@joohw/boss-cli@0.6.6 + @modelcontextprotocol/sdk@1.30.0  
> 远端机器：192.168.229.106 (Windows, SSH user: bowen)

---

## 一、项目背景

### 目标

将 boss-cli（Boss 直聘自动化 CLI 工具）通过 MCP 协议暴露为远程服务，使 AI Agent（Amazon Quick、Claude Code 等）能远程调用 Boss 直聘操作（推荐候选人、查看简历、打招呼等）。

### 核心约束

- boss-cli **依赖真实 Chrome 浏览器**（有头模式 + CDP），不能在容器/serverless 环境运行
- 同一 Chrome 实例 **不能并发操作**（点击页面需要独占焦点）
- Boss 直聘有 **反检测机制**（对操作节奏、浏览器指纹有要求）
- 登录需要手机 **扫码**（Cookie 保持在磁盘 profile 中）

---

## 二、最终架构

```
外部客户端 (Amazon Quick / Claude Code / 任意 MCP 客户端)
    │
    │  HTTPS + Authorization Bearer Token
    │  URL: https://boss.bowenfin.com:3100/mcp
    │       (公网 111.9.2.93:3100, DNS A 记录)
    ▼
┌─────────────────────────────────────────────────────┐
│  Nginx (192.168.229.106:3100)                        │
│  配置: C:\nginx\conf\nginx.conf                      │
│  功能:                                               │
│    • TLS 终止 (*.bowenfin.com 通配符证书)             │
│    • Token 鉴权 (map $http_authorization 精确匹配)   │
│    • 速率限制 (10r/s)                                │
│    • 强制注入 Accept header (兼容性)                  │
│    • proxy_pass → http://127.0.0.1:3101/mcp          │
└─────────────────────────────────────────────────────┘
    │  HTTP (明文, 仅本机回环)
    ▼
┌─────────────────────────────────────────────────────┐
│  boss-cli (192.168.229.106:3101)                     │
│  启动: node dist/mcp/http_server.js                  │
│  代码: C:\Users\bowen\boss-cli                       │
│  传输: StreamableHTTP (stateful, 内置 HTTP server)   │
│  功能:                                               │
│    • 20 个 MCP Tools (4个 search 已注释)             │
│    • 2 个 MCP Prompts (skills)                       │
│    • 按 Mcp-Session-Id 维护会话表，每次 initialize   │
│      建新 Server+Transport；关闭一律后台不 await     │
│    • 串行队列 serialize() 保证单线程操作             │
│    • 调用间随机间隔 1.8-5s (模拟人类节奏)           │
│    • 单次调用看门狗 240s                             │
└─────────────────────────────────────────────────────┘
    │  CDP (Chrome DevTools Protocol)
    ▼
┌─────────────────────────────────────────────────────┐
│  Chrome 浏览器 (有头模式, CloakBrowser 反检测)       │
│  调试端口: 53470                                     │
│  Profile: C:\Users\bowen\.boss-cli\.cache\browser-data│
│  登录态: Boss 直聘扫码登录后 cookie 持久保持          │
└─────────────────────────────────────────────────────┘
```

---

## 三、演进历程

### Phase 1：supergateway 中间层方案

```
Nginx → supergateway (HTTP→stdio) → boss-cli (stdio)
```

**选择原因**：boss-cli 原生只支持 stdio 传输，supergateway 零改动将 stdio 暴露为 HTTP。

**遇到的问题**：
| 问题 | 严重性 | 说明 |
|------|--------|------|
| stateless 模式进程泄漏 | 🔴 | 每个请求 spawn 新子进程，57 个 node 堆积不释放 |
| 多进程抢 CDP 端口 | 🔴 | 多个 boss-cli 实例争抢同一 Chrome，死锁 |
| stdio 管道假死 | 🔴 | 子进程卡住后 supergateway 检测不到，永远挂着 |
| 工作目录依赖 | 🟡 | 从非 boss-cli 目录启动时报 MODULE_NOT_FOUND |
| stateful 模式 session 过期 | 🟡 | "Server already initialized" 锁死 |

**弃用时间**：2026-08-24

### Phase 2：boss-cli 直接 HTTP 方案（当前）

```
Nginx → boss-cli (内置 StreamableHTTPServerTransport)
```

**改动**：
- 在 `src/mcp/server.ts` 中将 `StdioServerTransport` 替换为 `StreamableHTTPServerTransport` + `createServer`
- boss-cli 直接监听 3101 端口，去掉 supergateway 中间层
- 每次客户端 `initialize` 时调用 `rebuildSession()` 销毁旧 Server+Transport，创建新实例

**改进**：
- ✅ 单进程运行，无泄漏
- ✅ 启动命令简化为一条 `node` 命令
- ✅ 完整日志输出到 `~/.boss-cli/logs/`
- ✅ 客户端随时重连不报错

**遗留缺陷**：`rebuildSession()` 造成 6-14 分钟整体假死（见坑2），Phase 3 修复。

### Phase 3：会话表方案（当前）

**改动**：
- `src/mcp/server.ts` 拆为三块：`app.ts`（共享运行时 + `buildServer()`）、
  `server.ts`（stdio 入口）、`http_server.ts`（StreamableHTTP 入口）
- 删除 `rebuildSession()`；改为按 `Mcp-Session-Id` 维护会话表，每次 `initialize`
  建一套全新 Server+Transport
- 所有 `transport.close()` / `server.close()` 一律「先摘除、后台关闭」，**永不在请求路径上 await**
- 开启 TCP keepalive 检测静默消失的对端
- 3101 默认只绑回环

**验证**：重复与并发 `initialize` 均 200、session id 互不相同、耗时 3-64ms（事故时为 347656ms）；
未知 session 404、缺请求头 400、DELETE 后原 id 404；客户端在 SSE 中途 abort 后服务完全不受影响。

---

## 四、踩坑记录

### 坑1：MCP SDK "Server already initialized"

**现象**：客户端断开后重连，第二次 `initialize` 被 SDK 拒绝返回 400/500。

**根因**：MCP SDK 的 `Server` 类内部记录了初始化状态，一个 Server 实例只能 `initialize` 一次。

**解决（现行）**：按 `Mcp-Session-Id` 维护会话表，每次 `initialize` 用 `buildServer()` 建一套全新的
Server+Transport 并存入表中，**不触碰任何已有会话**。原先的「销毁旧的再建新的」（`rebuildSession()`）
已删除——它是坑2 的直接成因。

---

### 坑2：`transport.close()` 阻塞导致假死（已修复）

**现象**：`rebuildSession()` 耗时 6-14 分钟才返回，期间所有请求 499 超时；
node 进程在、3101 端口监听中，但没有任何 access log 产生。

**根因**（两层，缺一不可）：

1. **拆解操作被放在请求关键路径上。** `transport.close()` 收活跃 SSE 流走的是 `res.end()`，
   它要等终止 chunk 刷出去。公网客户端超时放弃时**不保证发 FIN**（NAT 静默丢弃、路由黑洞），
   此时 socket 仍是 ESTABLISHED，内核开始重传退避。解除阻塞的时机由 Nginx 的
   `proxy_read_timeout`（300s）拆掉上游连接决定，**不是应用能控制的量级**。
   证据：`initialize` 的 duration 记录到 `347656ms`（≈300s + 排队）与 `843010ms`。
2. **全局单例 `currentTransport` 无互斥。** 两个 initialize 并发时，B 会关掉 A 刚建好、
   正在服务 A 自己的 transport，A 的响应永远不被 `end()`，挂到 TCP 超时。

注意：`await rebuildSession()` 卡住的是 HTTP handler 这个 async 函数，
**不是 Node 事件循环**（重连路径上全是异步 I/O，没有同步 CPU 操作）。表现是逻辑层排队。

**已采纳方案（方案 C）**：会话表 + 关闭永不 await。见 `src/mcp/http_server.ts` 模块注释。
- 会话按 id 隔离，新会话建立永不触碰已有会话 → 消掉竞态
- 任何 `close()` 都先从表里摘除、再后台异步关闭 → 卡多久都没人等
- TCP keepalive 让「静默消失的对端」在 OS 层被探测出来

**已否决的两个方案**：

- ~~方案 A：`enableJsonResponse: true`~~ —— **无效**。这个开关只改 POST 响应形态，
  不影响客户端另开的 standalone GET SSE 通知流，而那条才是卡住的流（access log 里
  `GET /mcp 200 16125ms` 就是它）。而且 per-request SSE 流正是 10s progress 心跳的通道，
  关掉会让 240s 长任务失去对客户端的保活手段。用一个已知回归换一个换不掉的问题。
- ~~方案 B：单例 + fire-and-forget~~ —— 不完整。它解决了阻塞，但保留全局单例，
  上面根因 2 的竞态依然存在。

---

### 坑4（原「Chrome 进程退出后假死」）：诊断有误，已合并进坑2

原记录为「Chrome 退出后 boss-cli 重连 `connectBrowser()` 阻塞」。**这个判断已被现场数据否定**：

- 假死期间 `curl 127.0.0.1:53470` → exit 7、`tasklist` 无 chrome.exe → Chrome 压根不在
- `session.lock` 不存在 → 没有任何 tool 在执行
- `mcp-server.log` 无 `session is busy`

假死期间浏览器层完全没被触及。另外 `connectBrowser()` 三步均有超时保护：
探测 `/json/version` 800ms、spawn 后等 DevTools 地址 30s、CDP 命令由 puppeteer
`protocolTimeout`（默认 180s）兜底。**不要再去优化这条路径**。

---

### 坑3：`notifications/initialized` 返回 500

**现象**：`initialize` → 200 ✅，紧接着 `notifications/initialized` → 500 ❌，死循环。

**根因**：stateless 模式下 transport 无法跨请求保持状态。

**解决**：改为 stateful 模式（`sessionIdGenerator: () => randomUUID()`），所有请求通过 session ID 路由到同一对 Server+Transport。

---

### 坑4：Chrome 进程退出后假死

**现象**：boss-cli 进程在、端口监听中，但所有请求 499。

**根因**：Chrome 退出后，boss-cli 收到 tool 调用时尝试重连 Chrome（`connectBrowser()`），但由于某些原因阻塞。

**诊断方法**：
```cmd
curl -s http://127.0.0.1:53470/json/version
:: 返回 JSON = Chrome 活着
:: Exit code 7 = Chrome 不在运行
```

---

### 坑5：`detachBrowserSession()` 卡死

**现象**：`rebuildSession()` 中 `detachBrowserSession()` 耗时数分钟。

**根因**：Chrome 页面卡住时，CDP `session.detach()` 等待 Chrome 响应确认。

**已部署的修复**：加 5 秒超时保护
```typescript
await Promise.race([
  detachBrowserSession().catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 5_000)),
]);
```

**发现**：5 秒超时保护不够，实际阻塞发生在 `transport.close()`（见坑2）。

---

### 坑6：supergateway stateless 进程爆炸

**现象**：57 个 node.exe 进程堆积，内存占用 3.5GB+。

**根因**：supergateway stateless 模式每个请求 spawn 新子进程（boss-cli），子进程内部各自争抢同一 Chrome CDP 端口，互相死锁后进程不退出。

**解决**：去掉 supergateway，boss-cli 直接 HTTP。

---

### 坑7：公网 SNI 过滤

**现象**：用域名 `boss.bowenfin.com:3100` 从外网连接时 TLS Client Hello 后被 RST；用 IP 直连 `111.9.2.93:3100` 正常。

**根因**：公司出口设备（防火墙/WAF）按 TLS SNI 字段分流，未识别的域名直接 RST。

**状态**：未解决，需网管在出口设备加 SNI 白名单。

**临时绕过**：客户端用 IP 直连 + `-k` 跳过证书验证（或者对方本地建隧道）。

---

### 坑8：阿里云 OCR SignatureDoesNotMatch

**现象**：`boss_preview_resume` 截图成功但 OCR 返回 400。

**根因**：`.env` 中未配置（或配置错误的）`BOSS_ALIYUN_ACCESS_KEY_ID` / `BOSS_ALIYUN_ACCESS_KEY_SECRET`。

**解决**：在 `C:\Users\bowen\boss-cli\.env` 或 `C:\Users\bowen\.boss-cli\.env` 中配置正确的 AccessKey。

---

### 坑9：Nginx map Token 匹配问题

**现象**：客户端 403 Forbidden。

**排查方法**：开启 auth_debug.log 记录请求的 `$http_authorization` 原文：
```nginx
log_format debug_auth '$remote_addr - $time_local - "$request" '
                      'status=$status auth_header="$http_authorization" '
                      'ua="$http_user_agent"';
access_log C:/nginx/logs/auth_debug.log debug_auth;
```

**常见原因**：
- Token 中混入了中文全角字符（从中文输入法状态复制）
- 客户端 Token 多了一截（拼接了新旧两个 Token）
- `Bun/1.3.14` UA 的客户端在 GET 请求上不带 Authorization header

---

## 五、文件清单

| 文件/目录 | 位置 | 说明 |
|-----------|------|------|
| 源码 | `C:\Users\bowen\boss-cli\src\` | TypeScript 源码 |
| 编译产物 | `C:\Users\bowen\boss-cli\dist\` | `npm run build` 输出 |
| Skills | `C:\Users\bowen\boss-cli\skills\` | 3 个 skill (agent-review / batch-review / frontend-analysis) |
| .env (用户级) | `C:\Users\bowen\.boss-cli\.env` | OCR AccessKey 等 |
| .env (项目级) | `C:\Users\bowen\boss-cli\.env` | 浏览器引擎配置 |
| Nginx 配置 | `C:\nginx\conf\nginx.conf` | Token 鉴权 + 反向代理 |
| Nginx 参考配置 | `docs/nginx-mcp.conf.example` | 纳入版本管理的副本，改动两边同步 |
| SSL 证书 | `C:\nginx\ssl\bowenfin.com.crt/key` | 通配符证书 |
| Nginx 日志 | `C:\nginx\logs\` | access / error / auth_debug |
| MCP 日志 | `C:\Users\bowen\.boss-cli\logs\` | mcp-server.log / mcp-access.log |
| Chrome Profile | `C:\Users\bowen\.boss-cli\.cache\browser-data` | Cookie/登录态 |
| GitHub | `github.com/approdite9/boss-cli-mcp` (main) | 最新代码 |

---

## 六、运维操作

### 启动服务

```cmd
:: 1. 启动 Nginx
C:\nginx\nginx.exe -p C:\nginx\

:: 2. 启动 boss-cli MCP（HTTP 入口；必须在 boss-cli 目录下）
cd /d C:\Users\bowen\boss-cli
node dist/mcp/http_server.js
```

> `dist/mcp/server.js` 是 **stdio** 入口（MCP 客户端在本机拉起时用），远程部署要用
> `dist/mcp/http_server.js`。两者共享 `dist/mcp/app.js` 里的能力集。

### 重启

```cmd
taskkill /f /im node.exe 2>nul
taskkill /f /im nginx.exe 2>nul
C:\nginx\nginx.exe -p C:\nginx\
cd /d C:\Users\bowen\boss-cli
node dist/mcp/http_server.js
```

### 检查状态

```cmd
:: 进程
tasklist /fi "imagename eq nginx.exe" /nh
tasklist /fi "imagename eq node.exe" /nh

:: 端口
netstat -ano | findstr "3100 3101"

:: Chrome CDP
curl -s http://127.0.0.1:53470/json/version

:: session.lock（自锁死诊断）
type C:\Users\bowen\.boss-cli\.cache\session.lock
```

### 查看日志

```cmd
:: MCP 服务日志
type C:\Users\bowen\.boss-cli\logs\mcp-server.log

:: MCP 请求日志
type C:\Users\bowen\.boss-cli\logs\mcp-access.log

:: Nginx auth 调试日志
type C:\nginx\logs\auth_debug.log

:: 实时监控
powershell "Get-Content C:\Users\bowen\.boss-cli\logs\mcp-access.log -Wait -Tail 20"
```

> 日志是 UTF-8（带 BOM）。`Get-Content` 能正确识别；直接用 `type` 需要先 `chcp 65001`，
> 否则中文会按 GBK 解码成乱码，甚至因多字节序列吞掉换行让整段连成一行。

### access log 字段怎么读

```
2026-08-24T06:51:09.485Z POST initialize ip=107.20.212.21 session=- status=200 handler=0ms stream=0ms
```

| 字段 | 含义 |
|------|------|
| `ip` | 真实客户端地址（取 `X-Forwarded-For`）。用来区分本机探测与远程客户端 |
| `session` | `Mcp-Session-Id`；`initialize` 时必然是 `-` |
| `handler` | **处理耗时**，到 `handleRequest` 返回为止。这才是「服务端是否慢」的度量 |
| `stream` | **响应流存活时长**，到 HTTP 响应真正结束为止 |

判读规则：

- `handler` 大 → 服务端真的慢，查串行队列与业务
- `handler` 小、`stream` 极大 → **对端已消失**，`res.end()` 在等 TCP 重传，属正常收尾，服务本身健康
- GET（通知流）的 `handler` 显示 `-`：长连接的「处理耗时」无意义，`close` 事件先于 promise 落地

> 早期只有一个合并的 `duration` 字段（等价于 `stream`），曾把「对端消失」误读成「服务端阻塞」，
> 排查绕了一大圈。拆开就是为了避免重犯。

### 更新代码

```cmd
cd /d C:\Users\bowen\boss-cli
git pull origin main
npm run build
:: 然后重启 node
```

### Boss 直聘登录（Cookie 过期时）

```cmd
cd /d C:\Users\bowen\boss-cli
node dist/cli/index.js login
:: 在 RDP 桌面上扫码
```

---

## 七、客户端配置

```json
{
  "mcpServers": {
    "boss-cli": {
      "transport": "streamable-http",
      "url": "https://boss.bowenfin.com:3100/mcp",
      "headers": {
        "Authorization": "Bearer <nginx.conf 中引号内的完整 Token>"
      }
    }
  }
}
```

### 查看 Token

```cmd
type C:\nginx\conf\nginx.conf | findstr /C:"1;"
```

### 内网验证

```cmd
curl --resolve boss.bowenfin.com:3100:192.168.229.106 -X POST https://boss.bowenfin.com:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer <TOKEN>" -d "{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"id\":1,\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}"
```

---

## 八、已知遗留问题

| 优先级 | 问题 | 根因 | 建议方案 |
|--------|------|------|---------|
| ~~P0~~ | ~~`transport.close()` 阻塞假死~~ | 已修复：会话表 + 关闭不 await（坑2） | — |
| P1 | 阿里云 OCR 失败 | AccessKey 未配置/过期 | 更新 .env 中的 BOSS_ALIYUN_ACCESS_KEY_ID/SECRET |
| P2 | 公网 SNI 过滤 | 出口设备拦截未知 SNI | 网管加白名单 |
| ~~P3~~ | ~~无 watchdog 自动恢复~~ | 已提供 `scripts/win-service/watchdog-mcp.ps1` + `/health` 端点 | — |
| ~~P3~~ | ~~进程退出后无自动重启~~ | 已提供任务计划方案（见下方「十四」） | — |

> ⚠️ **不要按原计划做 NSSM 服务化。** Windows 服务运行在 Session 0，自 Vista 起与用户桌面
> 完全隔离——没有桌面、没有 GPU。而有头 Chrome 是本项目的硬约束（`local_guard.ts`：整套页面
> 守卫的成立前提是「真实机器 + 有头浏览器」，它刻意不伪造 `plugins` / `window.chrome`）。
> 在 Session 0 里跑 Chrome 会让 WebGL renderer 退化成 SwiftShader、丢失真实交互事件历史，
> 叠加已有 profile 就是一次「设备特征突变」的登录，直接威胁账号安全。
> 正确做法是**自动登录 + 登录触发的隐藏任务**，见「十四」。

---

## 九、关键技术决策记录

| 决策 | 选择 | 放弃的替代方案 | 理由 |
|------|------|--------------|------|
| 去掉 supergateway | 直接 HTTP | 继续用 supergateway | supergateway 进程泄漏/假死问题无法根治 |
| stateful 模式 | session per initialize | stateless | stateless 下 SDK Server 无法跨请求保持状态 |
| 会话管理 | 按 `Mcp-Session-Id` 维护会话表 | ①单例复用 ②单例 + 每次重建 | ①违反 SDK「一实例只能 initialize 一次」；②把依赖对端网络状态的 `close()` 放到请求路径上，且单例无互斥有竞态（坑2） |
| SSE 模式 | 保持 `enableJsonResponse: false` | 改 true | 该开关不影响 standalone GET 通知流（真正卡住的那条），且会切断 progress 心跳通道 |
| 死连接检测 | TCP keepalive | socket 空闲超时 | 通知流空闲是正常状态，按空闲杀会误杀健康连接；keepalive 才能区分「空闲但活着」与「已死」 |
| 传输入口 | stdio / HTTP 双入口 + 共享 `app.ts` | 单文件按环境变量分支 | 避免隐式分支；stdio 供 npm 用户本机使用，HTTP 供远程部署 |
| 3101 绑定地址 | 默认仅回环 | 绑 0.0.0.0 | 本进程零鉴权，非回环等于暴露可消耗配额的无鉴权端点 |
| 公共证书 | *.bowenfin.com 通配符 | 自签名 | 自签名在 Bun 客户端无法信任 |
| Nginx 反代 | 保留 | 去掉直接暴露 boss-cli | Token 鉴权 + 速率限制 + TLS 终止 |
| 4 个 search 工具注释 | 禁用 | 保留 | 业务需求，减少对外暴露的操作 |

---

## 十、假死诊断流程

```
客户端报 "MCP 未连接" 或超时
    │
    ├─ 检查 Nginx 日志 → 是否有请求到达？
    │   └─ 无 → 网络/DNS/SNI 问题
    │   └─ 有 403 → Token 不匹配
    │   └─ 有 499 → boss-cli 不响应（假死）
    │   └─ 有 504 → boss-cli 超时
    │
    ├─ 检查 node 进程 → tasklist /fi "imagename eq node.exe"
    │   └─ 不存在 → 进程已退出，需重启
    │   └─ 存在 → 检查 3101 端口
    │
    ├─ 检查 3101 端口 → netstat -ano | findstr 3101
    │   └─ CLOSE_WAIT 堆积 → 连接未被回收
    │   └─ ESTABLISHED 且 Send-Q 非零 → 写阻塞（坑2 的现场特征：对端静默消失，
    │                                    数据刷不出去，内核在重传）
    │   └─ 正常 LISTENING → 看 mcp-server.log 最后一条
    │
    ├─ 看 mcp-access.log 的 duration 字段 → 有没有异常长的请求？
    │   └─ initialize 长达数分钟 → 坑2 类问题（应已修复，若复现请贴日志）
    │   └─ 该时段完全无记录 → 请求没进到 handler，查 Nginx 与网络
    │
    ├─ 检查 Chrome → curl http://127.0.0.1:53470/json/version
    │   └─ Exit 7 → Chrome 不在运行（首次 tool 调用会自动拉起）
    │   └─ 返回 JSON → Chrome 活着
    │
    └─ 检查 session.lock → type %USERPROFILE%\.boss-cli\.cache\session.lock
        └─ 存在且 pid == node pid → 自锁死
        └─ 不存在 → 正常
```

---

## 十一、MCP 能力清单

### Tools (20 个可用)

| 工具 | 消耗配额 | 说明 |
|------|:--------:|------|
| boss_login | ❌ | 打开登录页 |
| boss_list_positions | ❌ | 读取职位列表 |
| boss_get_jd | ❌ | 抓取职位 JD |
| boss_recommend | ❌ | 读取推荐候选人列表 |
| boss_greet | ⚠️ 打招呼配额 | 对列表中候选人打招呼 |
| boss_preview_resume | ⚠️ 简历配额 | 预览在线简历(截图+OCR) |
| boss_list_candidates | ❌ | 读取聊天列表 |
| boss_open_chat | ❌ | 打开聊天会话 |
| boss_open_chat_by_index | ❌ | 按序号打开会话 |
| boss_send_message | ❌ | 发送消息 |
| boss_chat_action | ❌ | 会话操作(简历/备注/求简历等) |
| pool_add | ❌ | 候选人入池 |
| pool_list | ❌ | 查看池 |
| pool_get_detail | ⚠️ | 查看候选人细节(preview=true 消耗) |
| pool_remove | ❌ | 删除候选人 |
| pool_mark | ❌ | 打标记 |
| pool_clear | ❌ | 清空池 |
| pool_greet_all | ⚠️ 批量打招呼 | 批量操作 |
| pool_batch_resume | ⚠️ 批量简历 | 批量抓简历 |
| pool_export | ❌ | 导出 Markdown |

### 已注释工具 (4 个)

- ~~boss_search~~ / ~~boss_deep_search~~ / ~~boss_deep_search_set~~ / ~~boss_deep_search_match~~

### Prompts (2 个)

| Prompt | 说明 |
|--------|------|
| boss-agent-review | 三阶漏斗自动筛选（标签初筛→简历精筛→HR确认→批量打招呼） |
| boss-batch-review | 分批流式审核（逐批展示+实时决策） |

---

## 十二、串行队列与节流机制

```
请求进入 HTTP handler
    ↓
是 initialize？
    → 是：buildServer() 建全新 Server+Transport，存入会话表（不触碰已有会话）
    → 否：按 Mcp-Session-Id 查表
           ├─ 缺请求头 → 400
           ├─ 查不到   → 404（客户端应重新 initialize）
           └─ 命中     → handleRequest
    ↓
tool 调用进入 serialize() 串行队列（进程级单份，不随会话数增加）
    ↓ (FIFO 排队)
browserCallThrottle.beforeCall()
    ↓ (等待 1.8-5s 随机间隔)
spec.run(args, ctx)
    ↓ (实际浏览器操作 2-30s)
browserCallThrottle.afterCall()
    ↓
返回结果
```

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| BOSS_MCP_TOOL_TIMEOUT_MS | 240000 (4min) | 单次调用看门狗超时 |
| BOSS_MCP_HEARTBEAT_MS | 10000 (10s) | 心跳间隔（防客户端超时） |
| BOSS_MCP_CALL_GAP_MS | 1800-5000 | 调用间随机间隔（ms） |
| BOSS_MCP_PORT | 3101 | HTTP 监听端口 |
| BOSS_MCP_HOST | 127.0.0.1 | HTTP 绑定地址。**非回环会打出告警**：本进程零鉴权 |
| BOSS_MCP_SESSION_IDLE_MS | 14400000 (4h) | 会话空闲回收阈值。**只是兜底**，主回收路径是 `transport.onclose` |

> ⚠️ 不要把 `BOSS_MCP_SESSION_IDLE_MS` 调小。交互式客户端在人思考/读结果时可以空闲很久，
> 期间它只挂着 GET 通知流、不发新请求。会话被摘掉后客户端下一次调用拿到 404，
> 表现是「MCP 未连接」——而它其实一直连着。会话对象很小，留久没有代价。
> 实测踩过：阈值设 10 分钟时，客户端空闲 15 分钟后 `tools/list` 直接 404。

> `BOSS_MCP_TOOL_TIMEOUT_MS` 必须小于 Nginx 的 `proxy_read_timeout`（当前 300s），
> 否则 Nginx 先掐断连接，客户端拿到的是连接中断而不是那条可读的超时说明。
> 默认 240s 是贴着边过的，调大时要同步调 Nginx。
>
> 长任务（`pool_greet_all` / `pool_batch_resume`）靠 10s 的 progress 心跳给客户端保活，
> 所以**不要**为了「让客户端早点拿到错误」而把看门狗调到 90s 之类——那会把正常的批量操作打断。

### 不走浏览器的本地工具（不排队、不节流）

`pool_add` / `pool_list` / `pool_remove` / `pool_mark` / `pool_clear` / `pool_export`

---

## 十三、安全配置

| 层级 | 机制 | 配置位置 |
|------|------|---------|
| 传输加密 | TLS 1.2/1.3 (通配符证书) | `C:\nginx\ssl\` |
| 身份认证 | Nginx map 精确匹配 Bearer Token | `nginx.conf` |
| 防暴力破解 | `limit_req zone=mcp_limit` 10r/s | `nginx.conf`（**只声明 zone 不生效，必须在 location 里引用**） |
| 端口隔离 | boss-cli (3101) 默认仅绑 127.0.0.1 | `src/mcp/http_server.ts` + Nginx 回环转发 |
| 操作节流 | 1.8-5s 随机间隔 | boss-cli 内部 |
| 配额保护 | 打招呼/简历查看前要求确认 | tool annotations |

---

*文档结束*

---

## 十四、开机常驻与看门狗（Windows）

### 为什么不能用 Windows 服务

见「八」的告警。核心矛盾：**开机后无人登录时系统没有交互桌面，而有头 Chrome 必须有桌面。**
Windows 服务在 Session 0，没有桌面也没有 GPU。唯一同时满足两个条件的路径是
**自动登录建立真实会话 + 登录触发的隐藏任务**。

### 相关文件

| 文件 | 作用 |
|------|------|
| `scripts/win-service/run-mcp.cmd` | 启动脚本，输出重定向到 `logs\stdout.log` |
| `scripts/win-service/run-mcp.vbs` | 以**隐藏窗口**调用上面的 cmd |
| `scripts/win-service/watchdog-mcp.ps1` | 探活 → 留证 → 重启 |

> 编码要求：`.ps1` 必须是 **UTF-8 with BOM**（PowerShell 5.1 否则按 GBK 读，中文注释会
> 破坏解析）；`.cmd` / `.vbs` 保存为 **ANSI(CP936)**（cmd.exe 与 wscript 默认按 ANSI 读）。
> 改动这些文件后务必确认编码没被编辑器改掉。

### 为什么必须隐藏窗口

Windows 控制台默认开启「快速编辑模式」。**只要有人在窗口里点一下或拖选文本，进程就会在下一次
写 stdout/stderr 时被挂起**——不是崩溃、不是退出。此时 `tasklist` 有 PID、`netstat` 显示
LISTENING，一切看着正常，但所有请求超时、应用日志停止增长。历史上多次「假死」疑似由此造成。

双重防护：① 隐藏窗口（没有窗口可点）；② 输出重定向（进程根本不碰控制台）。

### 一次性配置

**1. 自动登录**（开机即建立交互会话）

推荐用 Sysinternals `Autologon.exe`——它把密码存进 LSA secret，而不是像直接改注册表
`Winlogon\DefaultPassword` 那样近乎明文：

```cmd
Autologon.exe bowen <域或机器名> <密码>
```

> ⚠️ 安全权衡：开启自动登录意味着任何能物理/控制台访问该机器的人都直接进入已登录桌面，
> 而这个桌面上有已登录 Boss 的 Chrome。请确保机器本身处于受控环境。

**2. 电源设置**（防止休眠把服务带走）

```cmd
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0
```

**3. 注册主任务**

```cmd
schtasks /create /tn "boss-mcp" /tr "wscript.exe C:\Users\bowen\boss-cli\scripts\win-service\run-mcp.vbs" /sc onlogon /ru bowen /rl highest /f
```

> 路径里没有空格，所以 `/tr` 内部不需要再嵌套引号。schtasks 对 `\"` 的处理很容易出错，
> 若将来路径含空格，请改用任务计划 GUI 创建而不是硬拼转义。

然后在 `taskschd.msc` 里打开 boss-mcp → **设置**页，必须调整两项默认值：

- **取消勾选**「如果任务运行时间超过以下时间，则停止任务」（默认 3 天会杀掉长驻进程）
- 勾选「如果任务失败，按以下频率重新启动」→ 1 分钟 / 重试 3 次

笔记本还要在**条件**页取消「只有在计算机使用交流电源时才启动此任务」。

**4. 注册看门狗任务**（每 2 分钟）

```cmd
schtasks /create /tn "boss-mcp-watchdog" /tr "powershell -ExecutionPolicy Bypass -NoProfile -File C:\Users\bowen\boss-cli\scripts\win-service\watchdog-mcp.ps1" /sc minute /mo 2 /ru bowen /rl highest /f
```

### 看门狗做什么

**判据是一次真实 HTTP 请求，不是查进程。** 这一点是关键：本服务两类历史故障期间，
node 进程都在、端口都还 LISTENING，`tasklist` / `netstat` 一个都抓不到。

探测 `GET http://127.0.0.1:3101/health`（10s 超时）。选 `/health` 而非 `/mcp` 的原因：
`initialize` 会在会话表里建记录，每 2 分钟一次会不断挤占 64 的会话上限，把真实客户端的
会话按 LRU 淘汰掉。`/health` 零协议副作用，不碰浏览器、不消耗任何配额。

失败处理：

1. **连续失败 2 次**才动手（单次失败可能只是抖动，不该重启一个可能正在跑长任务的服务）
2. **先留证再重启**——重启会毁掉现场。快照落在 `logs\crash\<时间戳>\`，含：
   `reason.txt`、四份日志副本、`netstat.txt`、`node-processes.txt`、`chrome-processes.txt`。
   后三者用于区分「进程没了」「端口没了」「都在但不响应（冻结/阻塞）」
3. **按 PID 结束进程**，不用 `taskkill /im node.exe`（那会连带杀掉机器上其它 Node 进程）
4. **不动 Chrome**——它是 detached 启动的，能跨 node 重启存活，登录态就在它的 profile 里。
   杀掉它会逼用户重新扫码
5. 等端口释放后启动，**并复验健康状态**，结果写进 `logs\watchdog.log`

### 日常检查

```cmd
:: 服务是否真的活着（最可靠的一条）
curl http://127.0.0.1:3101/health

:: 看门狗动作记录
powershell "Get-Content C:\Users\bowen\.boss-cli\logs\watchdog.log -Tail 20"

:: 历史故障现场
dir C:\Users\bowen\.boss-cli\logs\crash
```

`tasklist` / `netstat` 只能证明进程和端口存在，**不能证明服务可用**。判断服务健康请用
`/health`。

### 已知限制

**RDP 断开可以，注销不行。** 「只在用户登录时运行」意味着进程活在交互会话里。
RDP 断开连接时会话保持（disconnected 状态），Chrome 和服务继续运行；但**注销会话**
会把两者一起带走，需要重新登录（自动登录会在下次开机时恢复）。
