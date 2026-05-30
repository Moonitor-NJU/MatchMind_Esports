# MatchMind Esports

## Real-Time Esports Schedule and Qualification Analysis Agent

MatchMind Esports 是一个面向电竞观众的网页应用，聚焦英雄联盟等电竞赛事的赛程追踪、积分榜计算、晋级形势分析和自然语言问答。项目目标不是只展示“什么时候比赛”，而是解释“这场比赛为什么重要”“某支队伍怎样才能晋级”“如果某场打成 2:0 会怎样影响排名”。

## 核心功能

- 实时赛程看板：展示未开始、进行中、已结束比赛，支持状态筛选。
- 积分榜计算：根据赛果自动计算胜负、小分、剩余比赛和排名。
- 晋级形势分析：结合晋级名额、剩余赛程和小分，给出晋级主动权、高危边缘、理论淘汰等状态。
- 关键比赛识别：自动标记晋级关键战、排名影响战和常规赛程。
- AI 问答 Agent：用户可以提问“BLG 的晋级条件是什么”“哪场比赛最值得看”等问题。
- 假设推演：选择一场未结束比赛并设定比分，系统即时重算排名和晋级形势。
- 多模型接口预留：支持 DeepSeek、Qwen、Kimi、智谱 GLM；未配置 API Key 时使用本地规则引擎。

## 技术方案

项目采用零外部依赖的轻量架构，方便课程展示和部署：

- 前端：原生 HTML、CSS、JavaScript
- 后端：Node.js 原生 `http` 服务
- 数据：本地 JSON，可替换为 PandaScore、Riot Esports、Liquipedia 或自建爬虫数据
- AI：统一封装 DeepSeek、Qwen、Kimi、智谱 GLM Chat Completions 风格接口

处理流程：

```text
赛事数据
  -> 积分与小分计算
  -> 晋级规则判断
  -> 关键比赛识别
  -> 大模型/本地规则生成中文分析
  -> 前端展示与问答
```

## 快速开始

```bash
npm start
```

然后打开：

```text
http://localhost:3000
```

如果本机没有 npm，也可以直接运行：

```bash
node server.js
```

如果当前环境无法启动 Node，也可以使用 Python 兜底启动器：

```bash
python app.py
```

说明：Node 版本包含大模型 API 调用封装；Python 兜底版本主要用于本地展示和规则引擎分析。

## 大模型配置

默认使用本地规则引擎，不需要 API Key。若要调用大模型，可配置以下环境变量之一：

```bash
# DeepSeek
DEEPSEEK_API_KEY=your_key

# Qwen / 通义千问 DashScope 兼容接口
DASHSCOPE_API_KEY=your_key

# Kimi / Moonshot
MOONSHOT_API_KEY=your_key

# 智谱 GLM
ZHIPU_API_KEY=your_key
```

可选模型名：

```bash
DEEPSEEK_MODEL=deepseek-chat
QWEN_MODEL=qwen-plus
KIMI_MODEL=moonshot-v1-8k
ZHIPU_MODEL=glm-4-flash
```

可以把变量写入项目根目录的 `.env` 文件，`node server.js` 启动时会自动读取。`.env` 已在 `.gitignore` 中忽略，不会被提交到 GitHub。

## 实时赛事数据配置

项目支持优先拉取实时赛事 API，并在接口不可用时自动回退到 `data/tournaments.json`。当前内置 PandaScore League of Legends 赛程适配器：

```bash
# auto 会优先尝试实时接口，失败则回退本地数据；local 只使用本地演示数据
REALTIME_PROVIDER=auto

# PandaScore API Token
PANDASCORE_API_TOKEN=your_token

# 可选：默认 lol，也可以改成 pandascore 支持的其他游戏路径
PANDASCORE_GAME=lol

# 可选：限制拉取某些联赛，多个 id 用英文逗号分隔
PANDASCORE_LEAGUE_IDS=4197,297

# 可选：拉取最近/未来窗口
PANDASCORE_LOOKBACK_DAYS=14
PANDASCORE_LOOKAHEAD_DAYS=30
PANDASCORE_MATCH_LIMIT=50
```

PandaScore 默认会返回全球范围内的 LOL 近期赛程。为了避免把 LPL、LCK、LEC、EWC 预选赛、外卡赛区等比赛混进同一个积分榜，后端会按 `league + serie + tournament` 自动拆成多个赛事组，网页下拉框中分别展示。默认 `PANDASCORE_FOCUS=cn-major`，优先保留中国观众更常关注的 LPL、LCK、LEC、MSI、全球总决赛、EWC、First Stand、德玛西亚杯等赛事。

可选过滤配置：

```bash
# cn-major：重点赛事过滤；all：展示 PandaScore 返回的全部赛事组
PANDASCORE_FOCUS=cn-major

# 自定义保留关键词，命中 league/serie/tournament 任一字段即可
PANDASCORE_INCLUDE_KEYWORDS=lpl,lck,lec,ewc,msi,world championship

# 自定义排除关键词
PANDASCORE_EXCLUDE_KEYWORDS=academy,challengers,division 2
```

如果你想精确展示某些联赛，建议使用 PandaScore 的 league id：

```bash
PANDASCORE_LEAGUE_IDS=指定的联赛id
```

推荐 `.env` 示例：

```bash
DEEPSEEK_API_KEY=sk-你的DeepSeekKey
REALTIME_PROVIDER=auto
PANDASCORE_API_TOKEN=你的PandaScoreToken
```

如果只配置了 `DEEPSEEK_API_KEY`，系统会使用本地演示赛程并调用 DeepSeek 生成分析；如果同时配置 `PANDASCORE_API_TOKEN`，网页会显示 PandaScore 返回的近期真实赛程，再交给本地规则引擎和 DeepSeek 分析。

## 数据说明

当前 `data/tournaments.json` 中包含课程演示数据。真实部署时可以替换为：

- PandaScore API
- Riot Esports 官方数据
- Liquipedia 结构化数据
- 赛事官网爬虫
- 手动维护的 JSON/数据库

建议生产版本保留本地数据兜底，避免外部接口异常导致展示不可用。

## 项目亮点

普通赛程网站只告诉用户比赛时间，本项目会进一步解释比赛影响。例如：

- 某队当前是否掌握晋级主动权
- 下一场比赛对排名和晋级线的影响
- 2:0 和 2:1 对小分排序的不同影响
- 用户自然语言提问后的数据驱动回答

这使项目更符合“大模型/Agent 应用”的课程要求：大模型不是装饰，而是围绕结构化赛事数据完成解释、总结和问答。

## 后续扩展

- 接入真实赛事 API 并定时刷新。
- 增加战队收藏和赛前提醒。
- 增加更多游戏项目，例如 Valorant、DOTA2、CS2。
- 增加概率模拟，根据剩余赛程枚举所有可能赛果。
- 将 README 转换为 PDF 作为课程提交材料。
