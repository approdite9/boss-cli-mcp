---
name: boss-batch-review
display_name: Boss 分批流式审核
description: "在 Boss 直聘推荐页逐批展示候选人供 HR 实时审核并打招呼。适用于用户说 /boss_batch_review、分批审核、批量看推荐、逐个审核候选人等场景。"
icon: "👥"
trigger: /boss_batch_review 分批审核 批量审核 逐个看推荐
integration: boss_cli_local
inputs:
  - name: count
    description: "加载候选人数量（自动滚动加载到此数量）"
    type: number
    default: 50
  - name: batch_size
    description: "每批展示人数"
    type: number
    default: 10
tools: [load_tools, file_write, open_in_session_tab]
id: 599bc04e7b8d4987b801e67a27520ed1
---

## Overview

在 Boss 直聘推荐页面分批展示候选人，由 HR 实时决定对每个人打招呼或跳过。每批展示前**自动批量预览简历**获取完整信息（院校、专业、经历），弥补推荐卡片数据不全的问题，确保 HR 基于充分信息做决策。全程不离开推荐页，简历查看无限次不消耗配额。

## Prerequisites

加载 boss-cli MCP 工具（先用 `load_skill("user_mcp__boss_cli")` 确认工具前缀，通常为 `boss_cli__`）：
```
load_tools(["boss_cli__boss_list_positions", "boss_cli__boss_get_jd", "boss_cli__boss_recommend", "boss_cli__boss_greet", "boss_cli__boss_preview_resume"])
```

## ⚠️ 关键：`boss_recommend` 返回数据的局限性

`boss_recommend` 通过 DOM 抓取候选人卡片，但返回数据**不完整**：

| 信息维度 | 页面实际展示 | 工具返回 | 影响 |
|---------|------------|---------|------|
| 基本信息 | 姓名/年龄/应届年/学历/活跃状态 | ✅ 有 | — |
| 期望 | 城市+方向 | ✅ 有 | — |
| 薪资 | 薪资标签 | ✅ 有 | — |
| **院校名称** | 四川大学、电子科技大学等 | ❌ 缺失 | 无法判断院校层次 |
| **专业** | 计算机科学与技术等 | ❌ 缺失 | 无法判断专业匹配度 |
| **实习/工作经历** | 公司名+技术方向+时间段 | ❌ 缺失 | 无法判断实际经验 |
| **部分技能标签** | 如"分布式技术"、"Agent测试" | ⚠️ 部分缺失 | 标签不完整 |
| 优势标签 | QS前500、专业前15%等 | ✅ 有 | — |

**策略**：由于简历查看无限次且不消耗配额，每批展示前**批量调用 `boss_preview_resume`** 获取完整信息（院校、专业、项目经历、实习经历），然后以完整信息表格展示给 HR 决策。

## ⚠️ 去重规则（严格多字段匹配）

`boss_recommend` 返回结果中候选人可能重复出现。去重时**必须多字段联合匹配**，不得仅凭姓名去重（同名人很多）。

去重判定条件（以下字段**全部相同**才视为重复）：
- 姓名
- 年龄
- 学历（本科/硕士/博士）
- 应届年份
- 期望方向
- 薪资

只要任何一个字段不同，即视为不同候选人，保留两条。

## Workflow

### Step 1: 获取岗位列表 + 确认参数
- **Mode**: `agentic`
- **Input**: 无（或用户指定岗位关键词）
- **Output**: 用户确认的岗位名 + JD 摘要 + count + batch_size
- **Validate**: 至少获取到 1 个岗位
- **On failure**: 检查浏览器是否已登录 Boss 直聘，窗口是否可见

**流程**：
1. 调用 `boss_cli__boss_list_positions()` 获取当前账号所有在招岗位
2. 展示岗位列表给用户，让用户确认目标岗位（如只有 1 个岗位则直接使用）
3. 调用 `boss_cli__boss_get_jd(name=选定岗位名)` 获取完整 JD
4. 从 JD 提取核心要求摘要（后续展示时作为参考）
5. 确认 count 和 batch_size（使用默认值或用户指定值）

⚠️ **注意**：`boss_list_positions` 和 `boss_get_jd` 均依赖鼠标导航，需要浏览器窗口**可见且未最小化**。如果报 `Invalid parameters Failed to deserialize params.x` 错误，提示用户确保 Boss 直聘浏览器窗口可见。

### Step 2: 加载推荐候选人
- **Mode**: `deterministic`
- **Input**: `count={{count}}`，选定岗位的 jobKeyword（可选）
- **Output**: 去重后的候选人列表
- **Validate**: 去重后人数 > 0
- **On failure**: 检查推荐页是否正常加载，提醒用户确认登录状态

1. 调用 `boss_cli__boss_recommend(count={{count}})` 加载候选人
   - 如用户指定了岗位关键词，传 `jobKeyword` 参数
2. 按**严格多字段匹配**规则去重（姓名+年龄+学历+应届年+期望方向+薪资 全部相同才合并）
3. 告知用户：`已加载 N 条记录，去重后 M 位候选人，分 X 批展示（每批 {{batch_size}} 人）`

⚠️ **关键约束：从此刻起到流程结束，不得调用 `boss_list_positions`、`boss_get_jd` 或任何会离开推荐页的工具**，否则 DOM 重置，候选人列表丢失。

初始化计数器：`已查看简历: 0, 已打招呼: 0`

### Step 3: 批量预览简历 + 分批展示
- **Mode**: `agentic`
- **Input**: 当前批次的候选人（每批 {{batch_size}} 人）
- **Output**: 完整信息表格 + 等待用户指令
- **Validate**: 用户回复了有效指令

**每批流程**：
1. 对当前批次每位候选人调用 `boss_cli__boss_preview_resume(name=姓名)` 获取完整简历
2. 从简历中提取关键信息：院校、专业、实习/工作经历（公司+方向）、项目亮点
3. 将简历 OCR 保存到本地：`artifacts/resumes/姓名_日期.txt`
4. 以完整信息展示表格

优先展示"刚刚活跃"和"今日活跃"的候选人。展示格式：

```
【第 X 批 / 共 Y 批】已查看简历 A 个，已打招呼 B 个
JD 核心要求: [摘要]

| # | 姓名 | 院校·专业 | 学历 | 方向 | 薪资 | 活跃 | 实习/经历 | 推荐度 |
|---|------|----------|------|------|------|------|----------|--------|
| 1 | 向锐 | 电子科大·计算机 | 硕士 | Python | 15-30K | 在线 | 字节跳动·模型评测 | 🌟 |
| 2 | 龚昱帆 | 四川大学·计算机 | 本科 | 互联网 | 面议 | 在线 | 算秩未来·Golang | ⭐ |

请回复: "打招呼 1,3" / "全部打招呼" / "下一批" / "看原文 2" / "结束"
```

推荐度说明：
- 🌟 = 方向匹配 + 有实质经历/项目
- ⭐ = 部分匹配或有潜力
- ➖ = 匹配度较低（仍展示，由 HR 决定）

### Step 4: 执行用户指令
- **Mode**: `agentic`
- **Input**: 用户选择的编号/姓名
- **Output**: 操作结果 + 更新后的计数
- **Validate**: 工具返回成功消息
- **On failure**: 记录失败原因（如"未在列表中找到"），继续下一个

**指令处理**：
- "打招呼 1,3" → 逐个调用 `boss_cli__boss_greet(name=候选人姓名)`
- "全部打招呼" → 对当前批次所有人打招呼
- "看原文 2" → 展示已保存的本地简历原文（`artifacts/resumes/姓名_日期.txt`）
- "下一批" → 进入 Step 5 循环
- "结束" → 进入 Step 6 汇总

每次操作后展示：`✅ 操作成功。今日已查看简历 X 个，已打招呼 Y 个。`

### Step 5: 循环
- **Mode**: `deterministic`
- **Input**: 用户上一步指令
- **Output**: 回到 Step 3 展示下一批，或进入 Step 6 汇总

若用户回复"下一批"，回到 Step 3 处理下一批候选人。若用户回复"结束"或所有批次已展示完，进入 Step 6。

### Step 6: 汇总报告
- **Mode**: `agentic`
- **Input**: 全程操作记录
- **Output**: 汇总统计

```
本次审核完成：
总浏览: N 人（M 批）
打招呼: X 人（成功 A / 失败 B）
查看简历: Y 人
跳过: Z 人
今日累计：已查看简历 Y 个，已打招呼 X 个。
简历文件已保存至 artifacts/resumes/
```

## Output

- 对话中的分批完整信息表格 + 实时操作反馈 + 最终汇总报告
- 本地简历文件：`artifacts/resumes/姓名_日期.txt`（每位展示过的候选人一份）

## Lessons Learned

### Do
- **Step 1 先获取岗位+JD**：`boss_list_positions` → 确认岗位 → `boss_get_jd`，在进入推荐页之前完成
- **每批展示前先批量 preview_resume**：简历查看无限次不消耗配额，获取完整信息后再展示给 HR 决策
- **去重必须严格多字段匹配**：姓名+年龄+学历+应届年+期望方向+薪资 全部相同才去重
- 每批只展示当前批次，不重复前几批内容（节省上下文）
- 活跃优先排序，活跃候选人回复率更高
- 操作后立即展示计数器，让用户实时知道配额消耗
- 每位候选人简历存本地文件，用户可随时查看原文

### Don't
- **不要跳过 Step 1 直接进 `boss_recommend`**——没有 JD 就无法给出推荐度评估
- **不要仅凭姓名去重**——同名不同人非常常见，必须多字段联合判断
- **不要只展示卡片标签信息**——那些信息不完整，必须 preview_resume 获取完整数据
- **不要在 `boss_recommend` 之后调用 `boss_list_positions` 或 `boss_get_jd`**——会离开推荐页
- 不要一次展示超过 15 人（表格太长影响可读性）
- 不要在用户没确认前自动打招呼

### Common Failures
- `boss_list_positions` / `boss_get_jd` 报 `Invalid parameters Failed to deserialize params.x` — 窗口最小化/不可见。**处理**：提示用户确保浏览器窗口可见
- "未在列表中找到该候选人" — DOM 回收导致，记录失败继续下一个
- 简历 OCR 为空/不完整 — 可能是付费墙，标注后在表格中注明"简历不可用"
- 推荐页加载不到人 — 检查岗位是否开放中，是否已登录

### When to Ask the User
- Step 1 获取岗位列表后，确认目标岗位（多岗位时）
- 用户要求离开推荐页时必须警告（会丢失所有候选人）
- 打招呼累计接近 50 时提醒配额即将耗尽
