# MatchMind Esports

面向中国英雄联盟观众的实时赛事信息与 AI 观赛分析 Agent。

MatchMind 不只展示比赛时间和比分，还会结合实时赛程、赛事阶段、官方积分榜、淘汰赛签表、当前阵容、近期新闻和赛制规则，回答：

- 今天哪些比赛最值得看？
- 某场比赛为什么重要，胜负会如何改变后续路径？
- 常规赛晋级线还有哪些变数？
- 季后赛中某支队伍位于胜者组、败者组还是已经淘汰？
- 未进行的 BO3 / BO5 更看好谁，理由和爆冷条件是什么？

## 当前完成度

本项目已经达到课程 Demo 所需的核心目标，并形成了完整的数据到 Agent 输出链路：

```text
PandaScore 实时赛事与阵容
        +
赛事官网、国内网页与新闻搜索
        +
data/rules.json 赛制规则
        ↓
数据清洗、赛事分组、阶段识别
        ↓
常规赛积分分析 / 季后赛签表分析
        ↓
本地规则引擎生成可靠基础结论
        ↓
DeepSeek / Qwen / Kimi / 智谱生成中文观赛分析
        ↓
赛程、焦点、新闻、预测、问答和假设推演页面
```

相较于普通赛程网站，项目的 Agent 能力并非单纯把赛事数据发送给大模型。后端会先整理赛制、赛程、签表、阵容和新闻证据，并通过上下文约束避免模型把历史阵容、常规赛积分或不相关赛区信息套用到当前比赛。

### 课程要求对照

| 目标 | 当前实现 | 状态 |
| --- | --- | --- |
| 实时赛事日程整理 | PandaScore 实时赛程、比分、状态、分赛区赛事选择 | 已完成 |
| 结构化数据处理 | 赛事分组、官方积分榜、阶段识别、签表路径与阵容标准化 | 已完成 |
| Agent / 大模型能力 | 多模型赛事焦点、问答、赛前预测与新闻排序 | 已完成 |
| 大模型不是简单套壳 | 规则引擎先生成结构化上下文，并限制模型只能依据当前证据回答 | 已完成 |
| 用户交互 | 赛区切换、赛程筛选、新闻轮播、问答、AI 预测和比分推演 | 已完成 |
| 容错与可演示性 | API 失败回退本地数据；未配置模型时可使用本地规则引擎 | 已完成 |
| 面向真实观众的解释 | 区分常规赛和季后赛，结合阵容、新闻与观众关注度生成焦点 | 已完成 |
| 生产级稳定性 | 外部数据、新闻检索和复杂临时赛制仍存在不确定性 | 仍需持续维护 |
| 自动化测试 | 当前以语法检查和接口实测为主，尚未建立完整测试套件 | 待补充 |

## 核心功能

### 实时赛事数据

- 使用 PandaScore 拉取近期和未来英雄联盟赛程、比分与比赛状态。
- 按 `league + serie + tournament` 自动拆分赛事，避免不同赛区、赛段混入同一个榜单。
- 默认关注 LPL、LCK、LEC、LCS、LCP、MSI、全球总决赛、EWC 等主要赛事。
- 外部接口不可用时回退至本地演示数据，并在页面标明数据来源。

### 阶段自适应分析

- 常规赛优先展示 PandaScore 官方 standings、胜负场、小分和晋级分界。
- 官方 standings 不可用时仅展示“近期赛程推算榜”，不会宣称锁定晋级或理论淘汰。
- 季后赛自动切换为胜者组、败者组、已结束赛果、待战路径和淘汰风险，不再使用 `0-0` 积分榜分析。
- `data/rules.json` 保存不同赛事阶段的规则与重点权益，可独立维护。
- 具体轮次权益会结合完整签表和后端动态联网检索到的当前赛事规则交给大模型逐场判断，避免为某支队伍或某场比赛写死结论。

### AI 赛事焦点

- 综合关键比赛、签表路径、队伍关注度、新闻讨论度和当前赛况生成赛区焦点。
- 避免长期写死“黑马”“豪门”“复活甲争夺”等叙事，焦点会随数据刷新。
- 模型输出受到结构化上下文约束，不能凭训练记忆编造赛果、阵容或晋级结论。

### 当前阵容检索

- 优先通过 PandaScore team detail 接口补充当前队伍 roster。
- PandaScore 阵容缺失时，后端会检索阵容、首发名单和名单变动相关网页作为辅助证据。
- 阵容检索与普通新闻分开缓存和过滤。
- 模型只有在当前 roster 或检索证据明确出现选手名时才允许点名，避免使用历史阵容。

### 分赛区新闻轮播

- 默认使用玩加电竞、LPL/LOL 官方源、国内网页/RSS 和搜索结果作为新闻轮播来源。
- LPL 优先展示近期赛报、焦点战预告、首发名单和官方公告，减少外网链接失效和 B 站风控问题。
- B 站个人主页抓取已降级为实验模式；只有显式设置 `NEWS_MODE=bilibili-creator` 时才会启用。

### 预测、问答与推演

- 对未进行比赛生成 AI 赛前预测，说明看好方、关键胜负手、爆冷条件和不确定性。
- AI 问答支持询问整体形势、关键比赛、队伍路径和赛事焦点。
- 假设推演支持为未结束比赛设置比分并重新计算影响。
- 页面内支持 Markdown 格式的模型答案。

## 技术架构

- 前端：原生 HTML、CSS、JavaScript
- 后端：Node.js 原生 `http` 服务
- 实时赛事数据：PandaScore REST API
- 新闻与阵容证据：赛事官网、网页/RSS、搜索结果
- 本地规则：`data/rules.json`
- 大模型：DeepSeek、Qwen、Kimi、智谱 GLM 的 OpenAI 兼容 Chat Completions 接口
- 本地兜底：`data/tournaments.json` 与规则引擎

项目没有 npm 运行时依赖，Node.js 18 及以上版本即可启动。

## 快速开始

### 1. 配置环境变量

在项目根目录创建或编辑 `.env`：

```env
# 实时赛事数据
REALTIME_PROVIDER=auto
PANDASCORE_API_TOKEN=你的PandaScoreToken
PANDASCORE_GAME=lol

# 至少配置一个大模型；模型名称可按平台账号实际可用模型调整
DEEPSEEK_API_KEY=你的DeepSeekKey
DEEPSEEK_MODEL=deepseek-chat

DASHSCOPE_API_KEY=你的阿里云百炼Key
QWEN_MODEL=qwen-plus

MOONSHOT_API_KEY=你的KimiKey
KIMI_MODEL=moonshot-v1-32k

ZHIPU_API_KEY=你的智谱Key
ZHIPU_MODEL=glm-4-flash

# 新闻排序使用的模型提供商
DEFAULT_LLM_PROVIDER=deepseek
NEWS_RANK_PROVIDER=deepseek
```

只需要填写实际使用的平台。模型名必须是对应账户和 API 接入点当前支持的名称。

`.env` 已被 `.gitignore` 忽略，不要将 API Key 提交到 GitHub。

### 2. 启动服务

```powershell
cd D:\Projects\MatchMind_Esports
node server.js
```

也可以运行：

```powershell
npm start
```

浏览器访问：

```text
http://localhost:3000
```

如果出现 `EADDRINUSE`，说明端口 3000 已被其他进程占用：

```powershell
$env:PORT=3001
node server.js
```

## 可选配置

### PandaScore 查询范围

```env
# auto：优先实时数据，失败时回退本地数据
# pandascore：使用 PandaScore
# local：仅使用本地演示数据
REALTIME_PROVIDER=auto

# 默认重点联赛 ID
PANDASCORE_DEFAULT_LEAGUE_IDS=294,293,4197,5262,4198,5351

# 自定义联赛 ID，填写后覆盖默认列表
PANDASCORE_LEAGUE_IDS=

# 查询时间窗口
PANDASCORE_LOOKBACK_DAYS=2
PANDASCORE_LOOKAHEAD_DAYS=45
PANDASCORE_MATCH_LIMIT=100

# cn-major：主要赛事；all：PandaScore 返回的所有赛事
PANDASCORE_FOCUS=cn-major

PANDASCORE_INCLUDE_KEYWORDS=lpl,lck,lec,lcs,lcp,ewc,msi,world championship
PANDASCORE_EXCLUDE_KEYWORDS=academy,challengers,division 2
```

### 缓存与新闻

```env
# 新闻缓存，默认 15 分钟
NEWS_CACHE_TTL_MS=900000

# 新闻模式默认使用玩加电竞、官方源、国内网页/RSS/Tavily 聚合
NEWS_MODE=aggregate

# 可选：自定义新闻/RSS 源，多个地址使用英文逗号分隔
NEWS_FEEDS=

# 旧实验模式：只有显式设置 NEWS_MODE=bilibili-creator 时才读取 B 站个人主页
BILIBILI_NEWS_MID=1941869599
BILIBILI_NEWS_SOURCE_NAME=灯火电竞Pro
BILIBILI_NEWS_LIMIT=10
# 可选：如果 B 站接口返回 -352 风控，可填浏览器请求里的 Cookie/User-Agent，仅放本机 .env，不要提交
BILIBILI_COOKIE=
BILIBILI_USER_AGENT=
# 可选：B 站搜索兜底关键词
BILIBILI_NEWS_SEARCH_QUERY=灯火电竞Pro
# 默认只接受作者/标题/描述明确命中该 UP 主名称的搜索结果；设为 0 会放宽，但容易混入无关视频
BILIBILI_NEWS_STRICT_CREATOR=1
# 可选：B 站接口被 412/-352 风控时，可尝试 Tavily 搜索 B 站视频链接作为最后兜底。
# 默认关闭，因为搜索摘要可能混入 B 站侧边栏/热搜里的无关视频。
BILIBILI_TAVILY_FALLBACK=0
BILIBILI_TAVILY_QUERY="灯火电竞Pro" 英雄联盟 LPL 电竞 site:bilibili.com/video
# 可选：RSSHub 优先用于读取 B 站投稿，多个实例用英文逗号分隔
RSSHUB_BASE_URLS=https://rsshub.app
RSSHUB_TIMEOUT_MS=20000

# 阵容与名单证据缓存，默认 6 小时
ROSTER_CACHE_TTL_MS=21600000

# 当前赛事规则、资格和门票证据缓存，默认 6 小时
RULE_RESEARCH_CACHE_TTL_MS=21600000

# 完整 AI 分析缓存，默认 10 分钟；重复打开或切回赛事时可直接复用
ANALYSIS_CACHE_TTL_MS=600000

# 大模型请求超时和输出长度；演示时想更快可调低，想要更长分析可调高
LLM_TIMEOUT_MS=28000
LLM_MAX_TOKENS=2200

# 阵容/规则检索用于增强 AI 上下文；超时后页面会先展示可用分析，不会一直卡住
ROSTER_ANALYSIS_TIMEOUT_MS=9000
RULE_ANALYSIS_TIMEOUT_MS=12000

# 推荐：配置一个搜索 API 后，新闻、阵容补全和规则研究层会联网检索当前资料
# Tavily 搜索结果会被区分为规则事实与舆论观点；观点文章不能单独证明门票/晋级结论
TAVILY_API_KEY=
SERPER_API_KEY=

```

如果 `/api/news?refresh=1` 没有返回新闻，常见原因是当前启动 Node 的终端仍带有不可用代理，或外部站点临时不可访问。可以先在同一个 PowerShell 里清掉代理再启动：

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:GIT_HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:GIT_HTTPS_PROXY -ErrorAction SilentlyContinue
node server.js
```

然后另开一个 PowerShell 检查新闻接口：

```powershell
Invoke-RestMethod "http://localhost:3000/api/news?refresh=1" | ConvertTo-Json -Depth 5
```

如果仍然失败，接口返回的 `meta.warning` 会显示是 RSSHub、B 站官方接口还是网络层失败。此时可以在 `.env` 的 `RSSHUB_BASE_URLS` 填入你能访问的 RSSHub 实例，多个地址用英文逗号分隔。

## 后端接口

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/tournaments` | GET | 获取赛事、赛程、积分榜和阵容数据 |
| `/api/news?tournament=...` | GET | 获取当前赛事新闻 |
| `/api/roster?tournament=...` | GET | 检查当前赛事阵容与检索证据 |
| `/api/rule-research?tournament=...` | GET | 检查当前赛事动态检索到的规则、资格与门票证据 |
| `/api/analyze?tournament=...&provider=deepseek` | GET | 生成赛事整体分析 |
| `/api/chat` | POST | AI 赛事问答 |
| `/api/prediction` | POST | 未进行比赛的 AI 预测 |
| `/api/scenario` | POST | 比分假设推演 |

在需要强制刷新数据的 GET 接口后添加 `refresh=1`。

示例：

```text
http://localhost:3000/api/roster?tournament=赛事ID&refresh=1
```

## 数据可信度设计

项目会主动区分不同可信度的数据：

- **官方 standings**：可以用于完整常规赛排名和晋级线分析。
- **近期赛程推算榜**：仅用于展示近期结果，不宣称完整晋级结论。
- **PandaScore 当前 roster**：作为选手阵容的主要依据。
- **网页阵容证据**：用于补充首发和名单变化，但需要保留不确定性。
- **新闻标题与讨论度**：用于判断观赛话题，不作为比赛事实的唯一依据。
- **大模型结论**：必须基于提供的结构化数据；数据不足时应明确说明边界。

## 项目目录

```text
MatchMind_Esports/
├─ data/
│  ├─ rules.json              # 赛事阶段与晋级规则配置
│  └─ tournaments.json        # 本地演示与接口失败兜底数据
├─ public/
│  ├─ index.html              # 页面结构
│  ├─ app.js                  # 页面交互与渲染
│  └─ styles.css              # UI 样式
├─ src/
│  ├─ audience-baselines.js   # 队伍别名与基础关注度信号
│  ├─ env.js                  # .env 加载
│  ├─ http-utils.js           # HTTP 工具
│  ├─ llm-client.js           # 多模型调用封装
│  └─ news-cover.js           # 新闻封面处理
├─ server.js                  # 数据接入、规则引擎、检索层和 API
└─ README.md
```

## 当前限制

作为课程 Demo，当前版本已经覆盖实时数据、规则分析、Agent 问答、预测和交互展示；但它仍不是官方赛事裁决系统：

- PandaScore、新闻网站或搜索服务可能延迟、缺字段或暂时不可访问。
- 官方临时改制、加赛、选边权和复杂资格规则仍需要更新 `data/rules.json`。
- 网页检索结果可能受到网络环境、反爬措施和搜索质量影响。
- DeepSeek 等普通 Chat Completions 接口本身不会自动联网；规则研究层需要可访问的网页/RSS，或配置 `TAVILY_API_KEY` / `SERPER_API_KEY` 才能获得更稳定的联网规则证据。
- 当前预测用于辅助观赛，不代表博彩建议或确定赛果。
- `server.js` 仍然较大，后续适合继续拆分数据源、规则引擎、新闻检索和 Agent 服务。

## 课程展示建议

推荐按以下流程演示项目：

1. 切换 LPL、LCK、LEC、LCS、LCP，展示赛事与新闻会随赛区变化。
2. 对比常规赛积分榜和季后赛签表视图。
3. 展示 `/api/roster` 或赛前预测，说明当前阵容如何进入模型上下文。
4. 切换本地规则引擎与 DeepSeek，说明可靠基础结论和大模型表达增强之间的区别。
5. 选择一场未赛 BO5，运行 AI 预测并展示胜负手与不确定性。
6. 使用 AI 问答询问某支队伍的路径或当前最值得看的比赛。

项目的核心价值在于：**把实时赛事数据、动态赛制规则、网页检索证据和大模型表达组合成一个可解释的电竞观赛 Agent。**
