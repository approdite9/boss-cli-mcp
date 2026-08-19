---
name: boss-agent-review
display_name: Boss Agent 预筛选
description: "基于JD自动筛选Boss直聘推荐候选人，三阶漏斗（标签初筛→简历精筛→HR确认），最终批量打招呼。适用于用户说 /boss_agent_review、预筛选、自动筛选、帮我筛、智能招聘等场景。"
icon: "🎯"
trigger: /boss_agent_review 预筛选 自动筛选 帮我筛 智能招聘
integration: boss_cli_local
inputs:
  - name: count
    description: "加载候选人数量（自动滚动加载到此数量）"
    type: number
    default: 150
  - name: greet_limit
    description: "打招呼数量上限（每日配额约50-70）"
    type: number
    default: 50
tools: [load_tools, file_write, open_in_session_tab, run_python]
id: bd6c3a901e34474e9a8d4a4905e47d02
---

## Overview

三阶漏斗自动筛选流程：加载大量推荐候选人 → Stage 1 标签初筛 → Stage 2 批量看简历+AI精筛 → Stage 3 导出报告给HR确认 → Stage 4 批量打招呼。全程不离开推荐页，简历查看无限次，打招呼配额是唯一瓶颈（硬限 {{greet_limit}} 人）。

## Prerequisites

加载 boss-cli-local MCP 工具：
```
load_tools(["boss_cli_local__boss_list_positions", "boss_cli_local__boss_get_jd", "boss_cli_local__boss_recommend", "boss_cli_local__boss_greet", "boss_cli_local__boss_preview_resume"])
```

## Workflow

### Step 1: 加载推荐候选人 + 获取 JD
- **Mode**: `deterministic`
- **Input**: `count={{count}}`
- **Output**: 去重后的候选人列表 + 岗位名 + JD 筛选维度
- **Validate**: 返回人数 > 0
- **On failure**: 检查浏览器是否已登录 Boss 直聘

⚠️ **入口必须是 `boss_recommend`**——它通过 DOM 读取数据，不依赖鼠标精确坐标，窗口任何状态都能正常工作。不要用 `boss_list_positions` 作为第一步，该工具依赖侧边栏鼠标点击导航，窗口最小化/离屏时坐标为 NaN 会报 `Invalid parameters Failed to deserialize params.x` 错误。

1. 调用 `boss_cli_local__boss_recommend(count={{count}})` 加载候选人
   - 返回结果的第一行包含当前岗位名（如"当前岗位：前沿开发工程师（实习）"）
   - 如用户指定了岗位关键词，传 `jobKeyword` 参数
2. 从返回结果中提取岗位名
3. 调用 `boss_cli_local__boss_get_jd(name=岗位名)` 获取完整 JD
4. 从 JD 提取筛选维度：技术方向、学历、经验、薪资范围、硬性条件

⚠️ **关键约束：从此刻起到流程结束，不得调用任何会离开推荐页的工具。**

### Step 2: Stage 1 — 标签初筛
- **Mode**: `agentic`
- **Input**: 全量候选人列表 + JD 筛选维度
- **Output**: 通过初筛的候选人列表（约 60-80%）
- **Validate**: 通过人数 > 0

基于卡片标签信息快速过滤：
- 技术方向不匹配 → 排除（如 JD 要 Python，候选人期望 C++/前端/产品经理）
- 薪资期望远超预算（>10K 对实习岗）→ 标注⚠️但不排除
- "面议" → 视为合理
- 同事沟通过且无突出亮点 → 排除

告知用户：`初筛完成：N 人中 M 人通过，正在批量查看简历进行精筛...`

### Step 3: Stage 2 — 批量看简历 + AI精筛
- **Mode**: `agentic`
- **Input**: 初筛通过的候选人列表
- **Output**: 精筛后的分级推荐列表 + 本地简历文件
- **Validate**: 至少产出 1 位推荐候选人
- **On failure**: 放宽筛选标准重新评估

对每个初筛通过的候选人：
1. 调用 `boss_cli_local__boss_preview_resume(name=姓名)` 获取简历 OCR
2. 将简历 OCR 保存到本地文件：`artifacts/resumes/姓名_日期.txt`
3. 基于简历内容 AI 评估：
   - 实际项目经验（vs 课程作业）
   - 技术栈深度（框架使用 vs 深入理解）
   - 实习/工作经历质量
   - 论文/竞赛成果
   - 与 JD 核心要求的匹配度

每处理 10 人报告一次进度：`已完成 X/Y 份简历采集...`

分级结果：
- 🌟 强烈推荐：方向完全匹配 + 有实际项目/实习经验
- ⭐ 建议考虑：部分匹配，有亮点但存在不足
- ❌ 排除：简历内容与 JD 严重不符

### Step 4: Stage 3 — 导出报告给 HR
- **Mode**: `deterministic`
- **Input**: 精筛分级结果
- **Output**: Markdown 报告文件

导出为 `artifacts/推荐报告_岗位名_YYYYMMDD.md`，格式：

```markdown
# 推荐候选人 — [岗位名]
生成时间: YYYY-MM-DD HH:mm
JD 核心要求: [摘要]
漏斗数据: 加载 N 人 → 初筛 M 人 → 精筛 K 人

## 🌟 强烈推荐

| # | 姓名 | 学历 | 方向 | 薪资 | 活跃 | 推荐理由 | 简历文件 |
|---|------|------|------|------|------|---------|---------|
| 1 | xxx  | 硕士 | Python | 2-3K | 刚刚活跃 | 211+LangGraph，有腾讯实习 | [查看简历](artifacts/resumes/xxx_20260819.txt) |

## ⭐ 建议考虑

| # | 姓名 | 学历 | 方向 | 薪资 | 活跃 | 推荐理由 | 注意事项 | 简历文件 |
|---|------|------|------|------|------|---------|---------|---------|

## ❌ 已排除
- 初筛排除: X 人（方向不符）
- 精筛排除: Y 人（简历经验不足）
```

用 `open_in_session_tab` 打开报告文件。

### Step 5: HR 确认
- **Mode**: `agentic`
- **Input**: 用户查看报告后的回复
- **Output**: 确认打招呼的候选人列表
- **Validate**: 用户明确回复了指令

```
已筛选出 K 人推荐（强烈推荐 X + 建议考虑 Y），报告已打开。
今日已查看简历 M 个，已打招呼 0 个。打招呼上限: {{greet_limit}} 人。

请确认：
- "全部打招呼" — 对所有推荐人打招呼
- "打招呼 1,3,5" — 只对指定编号
- "去掉 2,4" — 排除这些，其余打招呼
- "看简历 3" — 查看某人的本地简历原文
- "调整标准: xxx" — 修改条件重新筛选
```

### Step 6: Stage 4 — 批量打招呼
- **Mode**: `agentic`
- **Input**: 用户确认的候选人列表
- **Output**: 打招呼结果
- **Validate**: 至少成功 1 人
- **On failure**: 记录失败原因，继续下一个

对确认列表逐个调用 `boss_cli_local__boss_greet(name=姓名)`，每人间隔 3-8 秒。

硬性限制：打招呼总数不超过 {{greet_limit}}。接近上限时提醒用户。

实时汇报：
```
✅ 1/20 刘先科 — 成功
✅ 2/20 马洪宇 — 成功
❌ 3/20 罗茜月 — 未在列表中
...
```

### Step 7: 汇总报告
- **Mode**: `agentic`
- **Input**: 全流程数据
- **Output**: 最终统计

```
本次预筛选完成：
漏斗: 加载 150 人 → 初筛 80 人 → 精筛 35 人 → HR确认 20 人
打招呼: 成功 18 / 失败 2
今日累计：已查看简历 80 个，已打招呼 18 个。
建议后续关注「沟通」页查看回复。
```

## Output

- 本地简历文件：`artifacts/resumes/姓名_日期.txt`（每位候选人一份）
- 推荐报告：`artifacts/推荐报告_岗位名_YYYYMMDD.md`（含简历文件链接）
- 对话中的实时进度 + 最终汇总

## Lessons Learned

### Do
- **始终用 `boss_recommend` 作为流程入口**——它通过 DOM 读取数据，不依赖鼠标坐标，窗口最小化/离屏/后台都能正常工作
- 简历无限查看 → 全量精筛，不要省简历配额
- 每位候选人简历存本地文件，报告中给出路径，方便 HR 或 Agent 随时翻看原文
- 打招呼前一定等用户确认，这是不可逆操作
- 活跃优先：刚刚活跃的候选人回复率显著更高

### Don't
- **不要用 `boss_list_positions` 作为流程第一步**——它依赖侧边栏鼠标点击导航（`Input.dispatchMouseEvent`），窗口最小化时坐标为 NaN 会报错。在 `boss_recommend` 已稳定打开推荐页后可作为可选岗位切换手段使用
- 不要在流程中离开推荐页
- 打招呼总数不要超过 {{greet_limit}}（每日配额约 50-70）
- 不要因为卡片标签信息不足就直接排除——初筛只排除明确不匹配的

### Common Failures
- "未在列表中找到该候选人" — 滚动加载后 DOM 回收，记录失败继续
- 简历 OCR 为空/不完整 — 可能是付费墙，标注后跳过
- 推荐页加载 0 人 — 检查岗位是否开放中
- `Invalid parameters Failed to deserialize params.x` — 窗口最小化导致坐标无效，避免在流程初始阶段使用依赖鼠标点击的工具

### When to Ask the User
- Stage 3 精筛后必须等 HR 确认才能打招呼
- 打招呼累计接近上限时提醒
- Agent 对某人匹配度判断不确定时，建议 HR 看原始简历文件决定
