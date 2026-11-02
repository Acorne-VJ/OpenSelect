# OpenSelect

本机 **OpenCode Go 多账号池**守护服务：官方用量监控 → 阈值（默认 97%）自动切换 → **请求级无缝故障转移代理**。在途 session 遇到 429 / 5xx / 无效 Key 时，代理在**响应首字节到达客户端之前**换号重试，客户端（opencode）无感，不中断。

> 当前版本 v0.1.0 · Bun + TypeScript 单进程 · 运行时零 npm 依赖（bun:sqlite 内置）

> 面向个人本机使用；供应商账号和 API Key 保存在使用者自己的设备上。

## 特性

- **官方用量监控**：每 45s 并行轮询 `GET /inference/go/v1/usage`，记录每账号 rolling / weekly / monthly 的 percent / status / resetsAt；官方 `percent` 为 0–100，统一归一化到 0–1（2% 不会再被放大 100 倍后按 150% 显示并误判限流）；若所有账号长期显示 0.0x% 且从不触发限流，说明上游刻度变更，需重新核对 `/v1/usage` 响应；重启后自动恢复 ≤24h 的最近用量快照，避免重启窗口误选已接近阈值的账号
- **阈值切换**：任一窗口达到阈值（默认 97%，可调 95–99%）时，新会话改选最低压力账号（sticky → least-pressure → fallback 三级策略）
- **请求级故障转移**：429 / 401 / 403 / 5xx / 网络错误在**响应首字节前**换号重试（最多 N 个，默认 4）；成功响应亦**预读首个数据块**——2xx 响应头已到、正文首字节前断流同样触发换号：429/5xx/网络 → 冷却换号；401 → 标记失效换号；403（模型/工作区级）→ **不毒化账号**，按（账号×模型）负缓存 15 分钟；实际发生替代尝试时切换记录带目的账号（尝试耗尽时目的为空）
- **会话亲和**：同一 `x-opencode-session` 固定账号；切换时面板可见切换记录，服务端不再额外打断
- **免费模型豁免**：账号付费窗口限流期间，free 模型仍可正常服务（实测）
- **免费模型优先（free-first）**：可指定若干免费模型，请求付费模型时先由免费模型承接；免费模型不可用（除 401 键失效外的任意错误）时自动回落到原付费模型，且**免费模型的失败不冷却账号**（付费流量不受影响）
- **Z.ai / MiniMax / DeepSeek 官方 / Command Code / Ollama Cloud 直连**：Anthropic 原生透传；Z.ai/MiniMax 模型别名 + `deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro`；Command Code 支持 Anthropic / OpenAI chat / responses；Ollama Cloud 原生 Anthropic/OpenAI 透传（API Key）；默认 Flash + `max` 思考度；5h/周额度、余额或云端 credits；`coding-auto` 按 Z.ai → MiniMax → opencode-go → DeepSeek 官方兜底
- **DeepSeek Search / Fetch**：`POST /v1/tools/search`、`POST /v1/tools/fetch` 代理 DeepSeek 原始 JSON API（Search/Fetch 独立计费；Key 来自 `DEEPSEEK_API_KEY` 或 `integration=deepseek` 账号）
- **三家族路径路由**：openai（/chat/completions、/responses）、anthropic（/messages）、google（/models/…:streamGenerateContent）单一 baseURL 全兼容
- **SSE 直通**：流式响应逐块透传（无累积缓冲，仅预读首个数据块用于故障转移判定）；上游 gzip 透明解压（剥 content-encoding）
- **控制台** `:8789`：**接入账号（多类型）、启停/删除账号、阈值与轮询设置、opencode 注入/撤销、模型可用性摘要（全量一致/差异数；完整明细见独立 `/models` 页）、账号池默认只显示可用账号（可切换全部）**；三窗口进度条与**用量历史曲线**（rolling/weekly/monthly 三线 + 阈值参考线，数据源为用量快照）、最近 24h 切换/请求摘要；完整日志见独立 `/switches` 与 `/requests`
- **统计页 `/stats`**：独立页面，按今天/24h/7天/30天 + 小时/天汇总**模型用量**（实际模型/请求模型）、**账号用量**（请求数/成功率/耗时/当前 5h/周/月额度）、**模型×账号**、**时间×模型**、**时间×账号** 表；与主控制台分开，避免单页堆叠
- **Token 统计页 `/tokens`**：采集 OpenAI/Anthropic/Responses/Google/Ollama 的 input/output/cache usage，按**供应商、账号、模型、客户端、时间**聚合；展示总 Token、估算支出、缓存命中、连接数、账号/模型排行、按小时/天趋势、91 天活跃度热力图与 24 小时节奏。流式翻译路径的 usage 标记为「估算」，上游未上报的显示「未上报」，不伪造
- **线路优化页 `/routes`**：对比 DeepSeek / Ollama Cloud / Z.ai 的高峰/非高峰窗口与订阅套餐分时规则；按「有效成本 × 账号压力 × 延迟 × 质量 × 可靠性」计算当前最优线路，并显示下一次切换时间。`data/time-pricing.json` 保存窗口，`bun run collect:pricing` 自动抓取官方页面更新；解析失败保留旧值并记录错误
- **CLI `opensel`**：init / add / import / remove / accounts / usage / status / serve / wire / unwire / sync-catalog / doctor / logs / install / uninstall
- **可逆集成**：wire 注入前自动备份 + 记录注入前原值（`wired.json`），unwire 一键回退并恢复原值（注入后被手动修改的条目保持不动）；launchd 登录自启
- **配置热加载**：`config.json` 变更（增删账号、策略、轮询间隔等）在 ≤1 个轮询周期内自动生效；监听端口变更需重启

## 架构

```
opencode（opencode-go 全部 37 个模型）
   │  providers.opencode-go.models.<id>.settings.baseURL = http://127.0.0.1:8788
   ▼
OpenSelect 代理 :8788                    ┌─────────────── 用量监控（45s 轮询）
   ├─ /chat/completions /responses ────► │  https://opencode.ai/inference/go
   │                     /openai/v1/...  │    + 账号池策略
   ├─ /messages ─────────────────────►   │    sticky → 最低压力 → 兜底
   │                     /anthropic/v1/… │
   └─ /models/<m>:streamGenerateC. ────► │  429 → cooldown + 换号重试
                         /google/v1beta/…└─ 401→invalid · 403→负缓存
```

## 本机统一出口（Claude Code / OpenAI）

:8788 同时是标准双协议出口——Anthropic / OpenAI 客户端直接接入，请求自动走账号池与故障转移；客户端未携带的 `x-opencode-session` 由代理自动合成（按凭据稳定），外部客户端零配置。

- **Claude Code（Anthropic 模式）**：`ANTHROPIC_BASE_URL=http://127.0.0.1:8788`、`ANTHROPIC_API_KEY` 任意占位；支持 `POST /v1/messages`、`/v1/messages/count_tokens`。`family=anthropic` 的 9 个模型（如 `claude-haiku-5-5`、`qwen3.8-max`、`minimax-m3`、`qwen3.7-max`）直通；`family=openai` 且 `api=chat` 的模型经本地协议翻译层调用（见下）。
- **上下文窗口**：Claude Code 的模型 ID 可带 `[1m]`（如 `deepseek-v4.1-flash[1m]`），代理转发前剥离；请求超过 1,048,576 会本地返回标准 Anthropic `prompt is too long`，让 Claude Code 触发 compact，不再把 1.05M 请求发到上游换 400。
- **OpenAI 模式**：base_url `http://127.0.0.1:8788/v1`，api_key 任意占位；支持 `POST /v1/chat/completions`、`/v1/responses`。可用模型为 `family=openai` 的 27 个。
- **模型清单**：`GET /v1/models`（或 `/models`）本地返回 51 个固定模型（37 个目录 + 7 个 zen 免费 + 4 个 Z.ai/MiniMax 别名 + 2 个 DeepSeek 官方别名 + `coding-auto`）+ 4 个 Command Code 短别名 + 配置 Ollama Cloud 账号后从 `/v1/models` 动态发现的 `ollama/<模型名>`，含 `family`、`free` 字段；固定模型零上游请求，Ollama Cloud 只在配置了账号时探测 `ollama.com`。
- **协议配对由上游强制**：跨协议请求返回 400 `ModelProtocolUnsupported`；按清单 `family` 字段选择协议即可。
- **免费模型实测（2026-10-19）**：`longcat-2.5-preview-free` 可用；`beam-free` 上游返回 403 地域限制；`cat-jam-free`、`step-5-preview-free` 已下架并从目录移除。免费模型不占配额、不受切换阈值影响。
- opencode 自身的 SDK 路径（`/messages`、`/chat/completions`、`/responses`、google `:generateContent`）与旧行为完全兼容。

### Claude Code 使用 openai/chat 模型（协议翻译）

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 ANTHROPIC_API_KEY=placeholder \
  claude --model glm-5.1
```

- `POST /v1/messages`（含 `?beta=true`）→ 上游 `/openai/v1/chat/completions`：system（含 mid-conversation system）、多轮消息、图片、tools/tool_choice、tool_result、stop_sequences 自动映射；流式 SSE 转为 Anthropic 事件序列。
- 仅支持目录内 `family=openai` 且 `api=chat` 的模型；`api=responses`（`grok-4.6`/`4.7`、`gpt-5.6-luna`、`gpt-6-luna`、`muse-spark-1.2`/`1.3-contributor`）与 `family=google` 模型经 `/v1/messages` 返回本地 400，不发上游请求。
- `POST /v1/messages/count_tokens` 对非 anthropic 模型本地近似（JSON 字节 / 4），不触发推理。
- 翻译只发生一次；429/5xx 换号重试复用同一份翻译结果。`anthropic-*` 请求头与 query（如 `?beta=true`）丢弃，认证自动替换为 `authorization: Bearer`。
- v1 限制：thinking/redacted_thinking/document 块丢弃；工具调用参数在流结束时整块下发（index 交错/缺失不丢，按 index 排序；混合 index/id 帧按别名合并为同一块——前提是上游 tool_call id 全局唯一，若上游对不同调用复用同一 id 会被合并并串接参数）；流式 `output_tokens` 为估算值。

### 一键配置 Claude Code 三个别名

给别人/新机器快速配置时，直接运行仓库里的脚本：

```bash
./scripts/install-claude-aliases.sh          # 默认写入 ~/.zshrc
source ~/.zshrc
```

写入 3 个别名，全部指向本机 OpenSelect，**不包含任何真实 API Key**：

| 别名 | 模型 | 说明 |
|---|---|---|
| `ds-cli` | `deepseek-v4.1-flash[1m]` | 付费 deepseek，走 OpenSelect 账号池 |
| `free-cli` | `deepseek-v4.1-flash-free` | 免费模型链 |
| `auto-cli` | `coding-auto[1m]` | Z.ai → MiniMax → opencode-go → DeepSeek 官方兜底 |

- 认证统一用 `ANTHROPIC_AUTH_TOKEN="openselect"` 占位；真实 Key 只在 `~/.openselect/config.json`。
- 默认代理 `http://127.0.0.1:8788`；其他机器/端口用 `--proxy http://host:8788`。
- `--shell bash` 写 `~/.bashrc`；`--file PATH` 写指定文件；`--dry-run` 只打印不修改。
- 脚本可重复执行：会替换自己的标记块并先备份原 rc 文件。

### 免费模型中转（free-first / free-fallback / off）

面板「免费模型」区块可**选用**哪些免费模型、**调优先级**，并切换三种模式：
`关闭`（不替换）/ `优先`（先免费后付费，省额度）/ `兜底`（平时用付费模型，付费全部不可用时才用免费模型接着）。

`优先` 模式下免费模型会**先于**付费模型被调用；免费模型额度用尽或不可用时自动回落到原请求的付费模型。

- **配置位置**：控制台 :8789「免费模型」区块（勾选 + ↑↓ 排序 + 模式下拉），或 `~/.openselect/config.json` 的 `policy.freeFirst`（有序数组）与 `policy.freeFirstMode`（`off`/`first`/`fallback`，默认 `first`）；CLI：`opensel free [--mode ...] [--use id1,id2]`
- **生效条件**：仅 `openai/chat` 家族可替换（`anthropic` / `google` / `responses` 协议不匹配，不替换）；客户端请求的模型**本身已免费**时不替换
- **失败语义**：免费候选返回任意错误状态（429/403/404/5xx/网络错误；**401 除外**——401 表示 key 失效，按账号级处理并移出池）→ 记 (账号×免费模型) 负缓存 15 分钟、**不冷却账号**、换下一个免费候选；全部候选失败则回落到原付费模型。回落时由 `pickAccount` 按**付费资格**重新选号：免费尝试占用的账号会被释放（不会被排除在付费选号池外），冷却/超阈值账号仍被避开
- **可观测性**：请求台账同时记录「客户端请求的模型」与「实际服务的模型」；面板请求流水显示 `请求模型 → 实际模型`，响应体 `model` 字段如实呈现实际服务模型。台账「尝试」列 = 上游请求次数（含免费候选尝试）
- **实测可用的 Go 免费模型**（2026-10-20 三账号实测）：`longcat-2.5-preview-free`、`minimax-m3.1-flash-free`；`beam-free` 返回 `RegionError`（地域限制，含中国）

### Z.ai / MiniMax / DeepSeek 官方 / Command Code / Ollama Cloud 直连

Z.ai / MiniMax / DeepSeek 按 Anthropic Messages 原生透传；Command Code 支持 Anthropic 与 OpenAI 两种协议；Ollama Cloud 同时提供 Anthropic 与 OpenAI 兼容端点，使用 API Key：

| 供应商 | Base / 协议 | 模型别名 | 默认思考度 | 用量端点 |
|---|---|---|---|---|
| Z.ai | `https://api.z.ai/api/anthropic` / Anthropic | `zai/glm-5.3-flash`、`zai/glm-5.3` | `thinking.enabled` + `reasoning_effort=max` | `GET https://api.z.ai/api/monitor/usage/quota/limit` |
| MiniMax（中国区） | `https://api.minimaxi.com/anthropic` / Anthropic | `minimax/MiniMax-M3.1-Flash`、`minimax/MiniMax-M3` | `output_config.effort=max` | `GET https://api.minimax.cn/v1/token_plan/remains` |
| MiniMax（全球区） | `https://api.minimax.io/anthropic` / Anthropic | 同上 | 同上 | `GET https://api.minimax.io/v1/token_plan/remains` |
| DeepSeek 官方 | `https://api.deepseek.com/anthropic` / Anthropic | `deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro` | `thinking.enabled` + `reasoning_effort=max` | `GET https://api.deepseek.com/user/balance`（CNY 余额） |
| Command Code | `https://api.commandcode.ai/provider/v1` / Anthropic + OpenAI chat/responses | `commandcode/deepseek-v4.1-flash`、`commandcode/glm-5.3-flash`、`commandcode/minimax-m3.1-flash`、`commandcode/kimi-k3.1-pro`；`cc/...` 同义；也支持 `commandcode/<厂商>/<模型>` 透传 | 原生透传，不注入 OpenCode 专用字段 | 无 5h/周窗口；Provider API 按量计费 |
| Ollama Cloud | `https://ollama.com/v1` / Anthropic + OpenAI | `ollama/<模型名>`（从 `/v1/models` 动态发现，如 `ollama/deepseek-v4.1-flash`） | 原生透传，不注入 | 无 5h/周端点；按量或订阅 credits |

- 账号类型选 `zai` / `minimax` / `deepseek-api` / `commandcode` / `ollama`；MiniMax 默认 `region=cn`，全球 key 在 config 里改 `region=global`。
- DeepSeek 官方账号固定 `fallbackOnly=true`：正常轮换、sticky、least-pressure 都不会选它；只有 opencode-go + 免费链 + zen 都不可用时才作为最后一层兜底。显式点名 `deepseek/deepseek-flash` 仍可直接用。
- 5 小时/周窗口映射到现有 `rolling/weekly`，继续用 `switchAt=0.99`；面板账号卡显示两条额度条。
- 供应商 429：有 `retry-after`/`limitName` 或账号用量已到 100% 才按恢复时间冷却；裸 429 只停 3 秒，不会把有余额的 MiniMax 隐藏 5 分钟。
- 思考度可用请求头 `x-openselect-effort: low|medium|high|xhigh|max` 覆盖，或账号配置 `defaultEffort`。
- `coding-auto`：Z.ai GLM-5.3-Flash → MiniMax M3.1-Flash → opencode-go `deepseek-v4.1-flash` → DeepSeek 官方 `deepseek-flash` 自动降级；固定别名（如 `zai/glm-5.3-flash`）只在该供应商内换 key。DeepSeek 官方账号默认 `fallbackOnly`，正常轮换不选，只有其它账号/供应商都不可用时才使用。
- Command Code 使用 Provider API Key（Bearer），支持 `/v1/messages`、`/v1/chat/completions`、`/v1/responses`；没有公开 5h/周额度端点，账号卡显示 0 额度，不参与阈值切换，但参与同 provider 多 key 故障转移。
- Ollama Cloud 需要 API Key；`baseUrl` 可覆盖默认 `https://ollama.com/v1`。代理原生透传 `/v1/messages`、`/v1/chat/completions`、`/v1/responses`；模型从 `/api/tags` 或 `/v1/models` 动态发现。
- 多 key：同一 provider 加多个账号即可，按压力/最近使用选号。
- 首页「价格对比」以 DeepSeek 官方 API 为 100%，分「套餐」「DeepSeek 订阅额度倍数」「API」三段展示；Ollama Cloud 按标准/off-peak 单价列入 API 表，并列入 Pro/Max/Team 订阅额度；OpenCode Go 的 DeepSeek 额度在高峰单价翻倍。套餐额度未公布美元值时标为「—」，不编造比例。

### DeepSeek Search / Fetch

OpenSelect 也提供原始 JSON 代理：

```bash
curl -X POST http://127.0.0.1:8788/v1/tools/search \
  -H 'content-type: application/json' \
  -d '{"query":"GLM-5.3 定价","count":5,"need_content":false}'

curl -X POST http://127.0.0.1:8788/v1/tools/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'
```

- Key 来源：`DEEPSEEK_API_KEY` 或面板里 `integration=deepseek` 的账号；不写日志、不回显。
- Search/Fetch 按成功请求计费（5 元 / 1000 次），与模型 token 额度独立。
- OpenCode 侧已安装 `deepseek-search` skill（`~/.config/opencode/skills/deepseek-search`），可直接让 Agent 调 Search/Fetch。

**免费模型的用量与重置（官方口径核查）**

| 问题 | 结论 |
|------|------|
| 免费模型怎么用量？ | **没有单独的免费模型用量接口**。Go 计划内免费模型标价 $0、月限额 Unlimited，**不消耗** 5 小时/周/月三个额度窗口，因此 `GET /v1/usage` 不反映免费模型用量；控制台的 "Free models" 是启用开关，不是用量表 |
| 额度用完怎么知道？ | 唯一信号是上游返回 429（带 `retry-after`）或模型被下架。OpenSelect 自行记录 (账号×免费模型) 负缓存并在请求台账/面板暴露 |
| 付费额度何时重置？ | 5 小时窗口 = 月限额的 20%、周 = 50%、月 = 100%；重置时间由 `GET /v1/usage` 的 `resetsAt` 给出（**UTC 绝对时刻**；面板按**本机时区**显示并附**倒计时**，与官方页 `Resets in Xd Yh` 同构） |
| 控制台里那 10 个 `-free` 模型？ | 上游 `GET /v1/models` 与官方文档均只有 3 个 free id（`longcat-2.5-preview-free`、`minimax-m3.1-flash-free`、`beam-free`）。控制台价目页另列 7 个 `-free` id（`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`jev-1.13-free`、`mimo-v2.6-flash-free`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`、`nemotron-3.5-super-vl-free`），它们**不在 Go 计划内**，实测三账号均返回 `Model is unavailable` |

## 功能总览

> 完整功能介绍与用法示例见 **[FEATURES.md](FEATURES.md)**（功能详解 / 控制台导览 / 典型用法 / 配置速查 / 已知边界）。

| 能力 | 入口 | 说明 |
|---|---|---|
| 多账号池 + 用量监控 | 面板「账号池」/ `opensel accounts` | 每 45s 轮询官方 `/v1/usage`，rolling/weekly/monthly 三窗口；重置时间按本机时区显示并附倒计时 |
| 阈值自动切换 | 面板「运行设置 → 切换阈值」 | 默认 97%（95–98%），越线自动切走 |
| 请求级无缝故障转移 | 透明 | 429/401/403/404/5xx/网络错误在首字节前换号重试，客户端无感；404「端点/模型不可用」（含 `unavailable` / `does not exist` / `not found` 等措辞）按「账号×模型」记负缓存并换号，同模型累计 3 个账号不可用即停；与模型无关的 404 原样透传 |
| 会话亲和 | 透明 | 同一会话固定账号，切换有记录 |
| 免费模型直接用 | 面板「免费模型」区块（复制 Claude Code 命令） | 免费模型经统一端口 `127.0.0.1:8788` 直接给 Claude Code / OpenAI 兼容客户端用，不占账号额度 |
| opencode zen 免费层直通 | 本地 opencode server `/generate` | 7 个 zen 免费模型（deepseek-v4.1-flash-free / nemotron-3-ultra-free / mimo-v2.6-flash-free / glm-5.3-flash-free / flint-40b-free / big-pickle / nemotron-3.5-*）经统一端口直接可用，不占账号额度；自动轮换，全挂时无缝落 `zen.fallbackModel`（默认 `deepseek-v4.1-flash`） |
| 免费模型中转 | 面板「免费模型」区块 / `opensel free` | **三种模式**：关闭（不替换）/ 优先（先用免费模型，省额度）/ 兜底（付费全部不可用时才用免费模型）；可逐个勾选候选并调优先级 |
| 本机统一出口（双协议） | `http://127.0.0.1:8788` | Anthropic `/v1/messages` + OpenAI `/v1/chat/completions`，零配置 |
| 协议翻译 | 透明 | Anthropic 请求 → OpenAI chat（Claude Code 可用 openai 系模型） |
| 模型目录同步 | `opensel sync-catalog`（面板「模型可用性」仅按账号刷新可用性视图） | 以账号实际 `/v1/models` 为准，零推理协议探测 |
| 模型可用性 | 面板右上「模型 →」/ `/models` | 默认只给结论（全量一致 / 差异数）；有差异才自动展开，账号多时不铺矩阵；支持搜索、只看差异 |
| 备份与签名 | 面板「备份与签名」/ `opensel backup`/`restore`/`keygen` | 归档列表、签名与验签状态、信任锚指纹、立即备份/备份并签名；恢复与远端推送在 CLI（破坏性操作不入面板） |
| opencode 接入 | 面板「opencode 接入」/ `opensel wire` | 37 个模型指向本机代理，可一键撤销还原；卡片内显示 opencode 的实测进池流量 |
| 接入（客户端）识别 | 面板「接入（客户端）」 | 按 User-Agent / 请求路径识别谁在用代理（opencode / Claude Code / 其他兼容客户端），台账逐请求记录接入 |
| 按接入指定账号 | 面板「接入（客户端）」/ `opensel pin <client> <account\|off>` | 某个接入的流量优先走指定账号（优先级：接入指定 > 全局手动指定 > 会话粘性 > 最低压力） |
| 当前连接可见 + 手动换号 | 面板「当前连接」/ `opensel force <account\|off>` | 正在服务的账号、手动指定、活跃会话与绑定明细；每账号「设为首选」立即重绑会话 |
| 用量统计 | 面板右上「统计 →」/ `/stats` | 独立统计页：模型/账号汇总 + 模型×账号/时间矩阵；支持今天/24h/7天/30天与小时/天粒度 |
| Token 统计 | 面板右上「Token →」/ `/tokens` | 总 Token / 估算支出 / 缓存命中 / 活跃账号模型；按供应商、账号、模型、客户端、时间聚合；支持全部历史 |
| 线路优化 | 面板右上「线路 →」/ `/routes` | 供应商/套餐分时窗口对比、最优线路、有效成本、账号压力、延迟、质量、可靠性、下一次切换、自动采集官方页面 |
| 请求流水 | 面板右上「请求 →」/ `/requests` | 按范围/接入/账号/状态/模型/关键词过滤，100 条/页；点详情看会话、家族、实际模型与错误 |
| 切换记录 | 面板右上「切换 →」/ `/switches` | 默认只看故障切换，可切「会话重绑」；按范围/账号/原因过滤，100 条/页 |
| 用量告警 | 面板「运行设置 → 告警阈值 / 分窗口 / 静默时段」 | 桌面通知 + 可选邮件 + 日志 + 台账；去重与冷却 |
| 应用级备份 | 面板「备份与签名」/ `opensel backup` | config+台账+wired+plist，SHA-256 校验；CLI/定时任务按 `--keep`（默认 14 份）清理，面板同样执行该保留策略 |
| 备份签名 | `opensel keygen` / `opensel backup --sign` | Ed25519 签 manifest+成员集合，远端拉取自动验签 |
| 私有 remote | `opensel backup --push/--fetch <git 远端>` | 累积式 push、加密可选、验签 |
| 异地备份（自动） | `opensel backup --remote <url\|off>` | 配置远端后，每日 03:30 的定时备份自动签名推送；面板「备份与签名」显示当前远端 |
| 定时自动备份 | launchd `com.openselect.backup` | 每日 03:30 |
| 历史用量快照修复 | `opensel repair-usage` | 清理旧解析器放大的历史行（近似修正） |
| 体检 | `opensel doctor` | 账号/代理/面板/接入/免费优先/告警/签名/最新备份 全链自检 |

## 快速开始

需要先安装 [Bun](https://bun.sh/)，并准备支持的供应商账号和 API Key。代理本体可跨平台运行；文中的 launchd 自动启动功能仅适用于 macOS。

```bash
git clone https://github.com/Acorne-VJ/OpenSelect.git
cd OpenSelect
./bin/opensel init
./bin/opensel serve
```

在浏览器打开 [http://127.0.0.1:8789](http://127.0.0.1:8789)，通过「接入账号」添加自己的供应商凭据。也可运行 `./bin/opensel import` 导入本机已有的 OpenCode 凭据。服务运行期间，请在另一个终端执行以下可选步骤：

```bash
./bin/opensel wire     # 将 OpenCode 的 opencode-go 流量接入代理
./bin/opensel unwire   # 需要时撤销接入
```

接入后重启 OpenCode。代理默认监听 `127.0.0.1:8788`，控制台默认监听 `127.0.0.1:8789`。配置及运行数据存放在 `~/.openselect/`；请勿将配置、数据库、备份或 API Key 提交到公开仓库。备份可能包含明文凭据，请使用私有存储或加密备份。

### 控制台（浏览器打开 http://127.0.0.1:8789）

- `/`：驾驶舱，只放账号池、当前连接、模型可用性、价格对比、切换/请求/告警等观察信息
- `/connect`：所有接入工作，放添加账号、opencode 接入、客户端指定、仅凭据账号
- `/settings`：运行参数、免费模型、备份与签名

| 页面 / 卡片 | 能做什么 |
|------|----------|
| `/connect` 套餐档位 | 添加账号时可选套餐；账号卡可直接改套餐（OpenCode Go/Plus/Teams、Z.ai Lite/Pro/Max、Ollama Pro/Max/Team、Command Code Go/GOAT/Pro/Max）；线路算法按套餐档位匹配 |
| `/connect` 添加账号 | 填 Key + 选类型（opencode-go / Google / Anthropic / OpenAI / DeepSeek / xAI / Z.AI / MiniMax / Command Code / Ollama / 自定义集成 ID）。opencode-go 与直连供应商进入切换池；Ollama Cloud 需要 API Key；其他仅凭据类型只注册 opencode 凭据、**不入切换池**；可勾选"同时注册到 opencode 凭据" |
| 价格对比 | 首页以 DeepSeek 官方 API = 100%，分「套餐」「DeepSeek 订阅额度倍数」「API」三段展示 OpenCode Go、Command Code、Z.ai、MiniMax、Ollama Cloud 等价格与比例；数据截至 2026-10-31，附官方来源 |
| `/settings` 运行设置 | 切换阈值滑杆（95%–99%）、轮询间隔（10–3600s）、切换后自动激活凭据；保存即热生效 |
| `/connect` opencode 接入 | 一键注入 / 撤销 baseURL（含 Google 模型 400 的 Privacy settings 指引）；显示注入状态与目标配置路径 |
| `/` 模型可用性 | 一键拉取**每个账号实际可用模型**（`GET /v1/models`，各账号可能不同），与内置目录 join 后标出免费模型，账号差异一目了然 |

开机自启：`./bin/opensel install`（launchd，`uninstall` 卸载）。

## 集成原理（实测结论）

- opencode 只认**模型级** `settings.baseURL` 覆盖；provider 级 `settings.baseURL` 与 legacy `provider.options.baseURL` 均被**静默忽略**（本项目 E2E 验证）。
- `opensel wire` 为 `providers.opencode-go.models.*` 全部模型写入 `settings.baseURL = http://127.0.0.1:8788`；写入前自动备份到 `~/.openselect/backups/`，并把每个模型的注入前原值记入 `~/.openselect/wired.json`——`unwire` 据此恢复原值（注入后被手动改过的模型保持手动值不动）。可 idempotent 重复执行。
- **代理不可用时的表现**：opencode-go 模型请求会连接失败；此时执行 `opensel unwire` 回退直连（重启 opencode）即可。
- 代理只影响 `opencode-go` provider，不影响 Zen 等其它 provider 与免费模型直连路径。

## 配置 `~/.openselect/config.json`（0600 权限）

```json
{
  "version": 1,
  "upstream": { "base": "https://opencode.ai/inference/go" },
  "proxy": { "host": "127.0.0.1", "port": 8788 },
  "dashboard": { "host": "127.0.0.1", "port": 8789 },
  "policy": {
    "switchAt": 0.97,            // 切换阈值：任一窗口用量 ≥ 97% 即切走
    "maxAttempts": 4,            // 单请求最多尝试的账号数
    "cooldownFallbackSec": 300,  // 无法解析 retry-after 时的冷却
    "sessionTtlSec": 7200,       // 会话亲和有效期
    "freeFirst": ["longcat-2.5-preview-free", "minimax-m3.1-flash-free"] // 免费优先候选（有序）
  },
  "monitor": { "pollSec": 45 },
  "opencode": { "autoActivate": true },   // 自动同步 opencode 活跃凭据
  "accounts": [
    { "id": "go-01", "label": "go-01", "integration": "opencode-go",
      "key": "oc_sk_…", "enabled": true, "addedAt": 1792366000000 }
  ]
}
```

运行时数据：`~/.openselect/data.sqlite`（用量/请求/切换台账）、`backups/`、`logs/`。
（`OPENSELECT_DB_PATH` 可覆盖台账路径，测试隔离用。）

## 策略细节

| 场景 | 行为 |
|------|------|
| 新请求 | 排序：会话粘性 → 压力最低 → 最近最少使用 |
| 窗口 ≥ 阈值 | 不再选它（有替代时）；全部越线时兜底使用最接近恢复的账号 |
| 上游 429 | 解析 `retry-after` + `metadata.limitName`，冷却该账号，换号重试 |
| 上游 401 | 标记账号 invalid，换号重试（轮询校验成功后自动恢复） |
| 上游 403 | 不标记账号失效；按（账号×模型）负缓存 15 分钟，仅换号重试 |
| 上游 403（opencode.ai Cloudflare 1010） | 空 UA / `Python-urllib` 等签名会被 WAF 返回 `browser_signature_banned`；代理统一上游 `User-Agent: opencode/1.0.0`。`coding-auto` 与普通 `deepseek-v4.1-flash` 的 403 会继续落 DeepSeek 官方；仅 400/413 不重试 |
| DeepSeek 官方余额不足 | 余额接口 `available=false` 时账号标记不可用；`coding-auto` 继续走链，普通 `deepseek-v4.1-flash` 若无其它可用账号返回 503，需充值或换 key |
| 上游 5xx / 网络错误（含 2xx 后首字节前断流） | 冷却（≤60s）并换号；切换记录带目的账号 |
| 免费模型 | 跳过阈值与限流检查（付费限流不影响免费额度） |
| 免费优先（freeFirst） | 客户端请求付费模型时先由免费候选承接；免费候选失败（429/403/404/5xx/网络错误，401 除外）→ 负缓存 15 分钟 + 换下一个候选，**不冷却账号**；全部失败则回落到原付费模型（按付费资格重新选号） |
| 全部尝试失败 | 原样回传最后一次上游错误给客户端 |
| 两处上限 | 用量展示上限 `USAGE_PERCENT_MAX=1.5`（usage.ts，允许显示 150% 超配额）vs 压力排序上限 `PRESSURE_MAX=1.2`（policy.ts，仅影响账号排序，不参与限流判定）——因此真实 150% 的用量在账号卡片上显示为 120% 压力，两者语义不同、不可相互对齐 |

## CLI 一览

| 命令 | 说明 |
|------|------|
| `opensel init` | 创建 `~/.openselect` 与默认配置 |
| `opensel add --key K [--label L]` | 添加账号（校验用量 + 注册 opencode 凭据，`--no-opencode` 跳过） |
| `opensel import` | 从 opencode 凭据导入 `opencode-go` 账号 |
| `opensel remove <label\|id>` | 从账号池移除 |
| `opensel accounts [--json]` | 账号列表与最近用量 |
| `opensel usage [--loop]` | 实时查询官方用量 |
| `opensel status [--json]` | 总览（服务/接入/账号/切换） |
| `opensel serve [--proxy-only\|--dashboard-only]` | 启动服务 |
| `opensel wire [--dry-run]` / `unwire` | 注入/撤销 opencode 配置 |
| `opensel sync-catalog [--write] [--json] [--no-probe]` | 模型目录同步：以账号实际 `/v1/models` 为准增删 `models.json`，自动探测新增模型协议；`--write` 应用并刷新 wire 注入 |
| `opensel logs [-n 20]` | 请求与切换日志 |
| `opensel backup [--out <path>]` / `[--list]` / `[--keep N]` | 应用级备份（config+台账+wired+plist，SHA-256 校验；默认保留最新 14 份） |
| `opensel restore <path\|latest> [--dry-run] [--no-service] [--yes]` | 从备份恢复（恢复前自动生成安全备份） |
| `opensel repair-usage [--apply] [--before <ts>]` | 清理旧解析器放大的历史用量快照（默认 dry-run；近似修正；只处理解析器修复时刻之前的行） |
| `opensel doctor` | 全链体检（账号/服务/接入/免费优先/告警/签名/最新备份） |
| `opensel alerts [-n 20]` | 查看用量阈值告警记录 |
| `opensel force <account\|off>` | 手动指定首选账号（全部流量优先走它；已有会话立即重绑；`off` 解除） |
| `opensel pin list` / `opensel pin <client> <account\|off>` | 按接入（客户端）指定账号：某个接入的流量优先走它（`off` 解除） |
| `opensel free [--mode off\|first\|fallback] [--use id1,id2]` | 免费模型中转：模式与候选（按优先级） |
| `opensel backup --remote <url\|off>` | 只设置/清除异地备份远端（不推送；执行 `opensel install` 让定时任务生效） |
| `opensel install` / `uninstall` | launchd 自启 + 每日 03:30 自动备份 安装/卸载 |

### 模型目录同步（以账号实际为准）

`data/models.json`（37 个模型）以账号实际 `GET /v1/models` 并集为源；目录落后或账号下架模型时执行：

```bash
./bin/opensel sync-catalog            # dry-run：显示 新增/移除/协议探测 结果，不写盘
./bin/opensel sync-catalog --write    # 应用：重写目录 + 自动刷新 wire 注入（重启服务/opencode 后生效）
```

- **只增删条目**：既有条目的名称/价格/家族等人工数据原样保留；新增条目自动派生默认值（名称自动美化、成本 0 占位），建议人工补全；
- **零推理协议探测**：新增模型经实际声明它的账号，按 `ModelProtocolUnsupported` 边界级联探测 anthropic → openai/chat → openai/responses → google；仅 2xx（正文不含协议/地域错误标记）或结构化错误信封（`error.message/type/status/code`）记为命中；2xx 携带错误标记、空 JSON、鉴权、限流、5xx、非 JSON 响应与网络异常一律记无法判定（`unknown` → 默认 openai/chat 并提示人工复核）；
- 移除的模型若已 wire 注入，`--write` 时会自动从 opencode 配置中清理（刷新失败会自动完整重试一次；仍失败则尽力保持注入并给出 `opensel unwire && opensel wire` 修复指引，所有输出模式均返回非零退出码）；
- `--no-probe` 跳过探测、`--json` 输出机读差异；
- 目录内 `api: "responses"` 标记仅支持 `/openai/v1/responses` 的模型（grok-4.6/4.7、gpt-5.6/6-luna、muse-spark-1.2/1.3-contributor）。

## 开发与测试

```bash
bun run collect:pricing  # 自动采集 DeepSeek / Ollama / Z.ai 分时窗口
bun test          # 277 个测试：策略单测 + 用量解析/并行轮询（含 0–100 低百分比回归、parseWindow→policy 接缝、/v1/models 响应校验）+ 免费优先路由（免费承接/429 换候选/负缓存生效/单账号回落付费/免费 5xx 与首字节断流回落且不冷却/回落时按付费资格重新选号/直接请求免费不替换/协议不匹配不替换）+ 代理集成（mock 上游：429/401/403/500/首字节前断流/32MB 上限场景、粘性、三家族路由与认证头、gzip、日志、重启用量恢复、Anthropic→OpenAI 协议翻译与错误映射）+ wire 往返（含注入前原值恢复与 A→B 代理迁移）+ dashboard（API/历史曲线/页面/查询上限语义/控制台管理 API/设置校验/模型拉取/wire 往返）+ CLI serve 集成（热加载/端口警告）+ 目录同步（reconcile/名称派生/零推理协议探测级联与错误边界/wire 刷新失败恢复）+ 翻译层单测（请求/响应/错误/SSE 任意切块、无尾换行、流内错误、工具调用交错与缺 index、混合 index/id 别名合并为单块、1→0 交错参数完整、流式 content_filter/length 结束原因、结束原因修正）+ 备份恢复（归档/manifest/sha256、校验失败中止、恢复前安全备份、dry-run 不写盘、旧 WAL/SHM 残留清理、保留策略）+ 面板 freeFirst 写入/校验/去重/回显 + 用量快照定向清理（只修「值>=1 且 status=ok」的污染行）
bunx tsc --noEmit # 类型检查
```

```
src/
  cli.ts      CLI 入口（15 个子命令）
  proxy.ts    核心代理：路径路由/换号重试/SSE 直通/压缩处理
  policy.ts   选号策略（sticky → least-pressure → fallback）
  state.ts    运行时状态（会话亲和/冷却/失效/用量快照与重启恢复）
  usage.ts    官方用量拉取与轮询
  wire.ts     opencode 配置注入/撤销（JSONC 容错、自动备份、注入前原值恢复）
  dashboard.ts 控制台（:8789，纯内联前端：账号管理/设置/接入/模型矩阵/历史曲线）
  stats.ts     独立统计页（/stats：模型/账号汇总 + 模型×账号/时间矩阵）
  tokens.ts    usage 解析（OpenAI/Anthropic/Responses/Google/Ollama，含 SSE tap）
  token_stats.ts Token 统计后端与 /tokens 页面（供应商/账号/模型/时间）
  routes.ts    线路优化后端与 /routes 页面（分时窗口 + 套餐 + 账号压力）
  time_pricing.ts 分时窗口数据加载/自动采集（data/time-pricing.json）
  availability.ts 独立模型可用性页（/models：默认只给结论，差异才展开）
  logs.ts      独立日志页（/requests 请求流水、/switches 切换记录）
  providers.ts 供应商注册表（Z.ai / MiniMax / Command Code / Ollama / coding-auto）
  provider_proxy.ts 直连供应商原生透传与故障转移
  ollama.ts    Ollama Cloud 模型发现（/api/tags、/v1/models，Bearer Key）
  pricing.ts   首页价格对比表（DeepSeek 官方 API = 100%）
  tools.ts      DeepSeek Search/Fetch 代理
  db.ts       SQLite 台账（bun:sqlite）
  config.ts / catalog.ts / types.ts / util.ts
data/
  models.json       37 个 opencode-go 模型目录（家族/免费标记/子协议 api）
  plan-limits.json  Go / Go Plus 官方限额表
  time-pricing.json 供应商/套餐高峰与非高峰窗口、来源与采集时间
```

## 备份与恢复

单磁盘故障、误改配置、Key 泄漏都需要可回退。`opensel backup` 做**应用级**备份（区别于 wire 注入 opencode 配置的备份）：

```bash
./bin/opensel backup                  # 打包到 ~/.openselect/backups/openselect-<ts>.tar.gz
./bin/opensel backup --list           # 列出历史备份（时间/大小/文件数）
./bin/opensel backup --out /path/x.tgz   # 指定输出路径
```

**归档内容**（全部 0600）：

| 文件 | 作用 |
|---|---|
| `config.json` | 账号池配置（含明文 `oc_sk_` Key） |
| `data.sqlite` | 用量快照 / 请求流水 / 切换台账（用 SQLite `VACUUM INTO` 取一致性快照，绕开 WAL 边界；退化时 manifest 会标 `snapshotMethod=file-copy` 并告警） |
| `wired.json` | opencode 注入状态（`unwire` 回退依据） |
| `com.openselect.agent.plist` | launchd 常驻服务定义 |
| `com.openselect.backup.plist` | launchd 定时备份任务定义 |

同时写出两个 sidecar：`<归档>.sha256`（归档摘要）与 `<归档>.manifest.json`（逐文件 bytes + SHA-256）。

**恢复**：

```bash
./bin/opensel restore latest --dry-run   # 预览将被覆盖的文件（不写盘）
./bin/opensel restore latest --yes       # 实际恢复
```

恢复流程：**校验 → 生成「恢复前」安全备份 → 停 launchd 服务 → 写回文件 → 重启服务**。

- 校验不通过（归档被截断/篡改/文件缺失）→ **拒绝恢复**，不写任何文件
- manifest 只接受 `config.json` / `data.sqlite` / `wired.json` / `com.openselect.agent.plist` 四个已知文件名，其它名字（越界/穿越）一律拒绝
- 校验与恢复全程**流式**解包，不把归档解到磁盘（明文 Key 不落临时目录）
- 恢复前自动生成 `openselect-pre-restore-<ts>.tar.gz`，因此恢复本身可回退
- 恢复 `data.sqlite` 时会清除旧库的 `-wal` / `-shm` 残留（否则旧事务会被重放到新库，导致 `database disk image is malformed`）
- `--no-service` 可跳过服务启停（自行重启）

### 用量阈值告警

任一窗口（rolling / weekly / monthly）越过配置阈值即告警，**只提醒、不影响选号**（切换阈值是另一回事）。

```bash
opensel alerts          # 查看告警历史
```

- 触发通道：macOS 桌面通知（`osascript display notification`，异步不阻塞代理）+ **邮件**（可选 SMTP）+ `~/.openselect/logs/alert.log` + 台账 `alerts` 表（面板「用量告警」表 / `opensel alerts` 可见）
- 阈值可在面板「运行设置 → 告警阈值」配置（逗号分隔百分比，取值 1–150，默认 `90, 95, 97`），或 `config.json` 的 `policy.alertAt`（0..1 比例）
- **按窗口分档**（可选，面板「分窗口」三栏：rolling / weekly / monthly，留空=跟随全局）：`policy.alertAtByWindow = { "weekly": [0.95] }`
- **静默时段**（可选，面板「静默时段」）：`policy.alertQuiet = { "from": "23:00", "to": "07:00" }`（本地时间，跨零点自动处理）——静默期间**只记台账与日志，不发通知**
- **邮件通道**（可选，`config.json`）：`policy.alertEmail = { "to": ["ops@example.com"], "from": "openselect@example.com", "host": "127.0.0.1", "port": 25 }` —— 内置极简 SMTP 客户端（明文传输，建议仅用于本机/内网自建 SMTP）
- 去重语义：**同一次越线只告警一次**；用量回落到阈值以下即「解除」（台账历史行**保留**，仅标记为已回落），下次再越线会重新告警
- 冷却：`policy.alertCooldownSec`（默认 21600s = 6h）——同一档两次告警的最小间隔，避免阈值附近抖动反复弹窗
- 同一轮轮询的多个越线项**合并成一条通知**（降噪）
- 无 GUI 会话（纯 SSH / launchd 非用户会话）时桌面通知会失败，但台账与日志照常记录，不影响判定

### 历史用量快照的近似修正

2026-10-20 之前的用量快照由旧解析器写入（0..2 的原始百分比被当成 0..1 比例，2% 会记成 150%）。
`opensel repair-usage` 只修**可辨识的污染行**（窗口值 >= 1 且该窗口状态为 `ok`；真实达到 100% 的窗口上游会标 `rate-limited`，不会被误改）：

```bash
opensel repair-usage            # dry-run：只报告命中数量/窗口/账号
opensel repair-usage --apply    # 按「存值/100」近似还原（1.0 → 0.01，1.5 → 0.015）
```

- 修正只触及**解析器修复时刻之前**写入的行（`--before` 可指定其它边界），避免误伤将来合法的 100%+ok 行
- 落在 (0,1) 区间的存值无法与真实值区分（0.5 可能是 0.5% 也可能是 50%），一律保持原样
- 这是**近似**修正，不是精确还原

### 备份签名（真实性）

SHA-256 只能证明「文件没损坏」，不能证明「这份备份真的来自我这台机器」（归档与 sidecar 同源，可自洽伪造）。**签名**补上这一环：

```bash
opensel keygen                     # 生成 Ed25519 密钥对（~/.openselect/keys/，私钥 0600）
opensel backup --sign              # 备份时对 manifest 签名 → 生成 <归档>.sig
opensel backup --push <remote> --sign --yes   # 签名 + 推送
opensel backup --fetch <remote>     # 拉取时用本机公开钥自动验签
```

- 私钥只在本机（`~/.openselect/keys/ed25519-private.pem`，**不要外传**）；公开钥是**信任锚**，可分发给其它机器核对
- 签名覆盖 manifest（内含逐文件摘要）→ 验签通过即证明「这份归档确实由持有该私钥的机器生成」
- 远端归档被篡改（连同 sidecar 一起伪造）→ 验签失败 → **拒绝恢复**
- **本机已配置信任锚时，无签名的归档一律拒绝**（"无签名" = 无法证明来源；确需放行用 `--allow-unsigned`）
- 签名同时绑定**归档成员集合**：往已签名归档里追加/删除成员 → 拒绝
- 没有公开钥时退化为「仅完整性校验」，CLI 会明确提示
- 边界：签名保证**来源**，不保证**新鲜度**（旧的有效签名归档可被回放替换最新归档）
- `opensel status` 显示当前信任锚指纹

### 私有 remote（git 远端）

把备份推到自己的 git 远端（另一台机器/私有仓库），避免单磁盘故障。

```bash
# 推送（会写远端，需显式确认）
opensel backup --push git@github.com:you/openselect-backups.git --yes

# 加密推送（推荐）：口令只从环境变量读取，不进命令行/不进日志
export OPENSELECT_BACKUP_PASSPHRASE='…'
opensel backup --push git@github.com:you/openselect-backups.git --encrypt --yes

# 从远端拉回本机并逐个校验 SHA-256（校验不通过的不会落地）
opensel backup --fetch git@github.com:you/openselect-backups.git
```

- 远端分支固定为 `openselect-backups`；**每次推送在其上追加一个 commit**（不快进覆盖 → 远端保留历史备份，文件名带毫秒时间戳）
- 明文推送会在**推送前**打印醒目告警「**明文，含账号 Key**」——用**私有**仓库，并优先加 `--encrypt`（加密路径只推密文与其摘要，不推明文 manifest）
- 加密归档用 `openssl enc -aes-256-cbc -pbkdf2 -salt`；还原：`openssl enc -d -aes-256-cbc -pbkdf2 -salt -in <file>.enc -out <file>.tar.gz`；`--fetch` 会用 `OPENSELECT_BACKUP_PASSPHRASE` 自动解密并落地
- 拉取时**先校验后落地**（不覆盖本机已有同名归档），损坏/摘要不符的归档直接拒绝且不落地；缺口令等无法取回的情况会显式报出，不会「拉了 0 份」却当成功
- ⚠ **信任边界**：SHA-256 单独使用只防**损坏/传输错误**，**不防恶意远端**（归档与其 sidecar 同源，能自洽伪造）；本项目已用 **Ed25519 对 manifest + 成员集合签名**补齐真实性（见「备份签名」节），但签名只保证来源、不保证新鲜度（旧的**有效**签名归档可被回放替换最新归档）

### 自动备份与保留策略

`opensel install` 会同时安装两个 launchd 任务：

| 任务 | 作用 |
|---|---|
| `com.openselect.agent` | 常驻服务（代理 :8788 + 面板 :8789 + 用量轮询） |
| `com.openselect.backup` | 每日 03:30 执行 `opensel backup --keep 14 --sign-if-possible`（有私钥则签名；机器睡眠/关机时跳过，不补跑） |

保留策略：每次备份后按创建时间保留最新 **14** 份（`--keep N` 可调，`--keep 0` = 不清理），其余归档连同 sidecar 一并删除。

> 归档含**明文账号 Key**：权限 0600，备份目录 0700，请存放在加密卷，或推到只有你可见的私有 remote。

## 已知限制

- 单账号时只能"兜底继续用"，无法真正换号（至少 2 个账号才有故障转移意义）
- 受工作区隐私设置限制的模型（实测 `gemini-4-argon-contributor` 返回 400 "隐私/训练数据" 拒绝、`gpt-6-luna` 返回 403）：需在 OpenCode 工作区 Privacy settings 开启"允许训练请求数据的付费端点"；403 已有（账号×模型）负缓存兜底，均不毒化账号
- 端到端"无字节"静默上限 ≈255s（`Bun.serve` idleTimeout 上限）：极端情况下超过 4 分钟无任何字节的 SSE 会被断开；上游 fetch 侧 10 分钟空闲超时不改变这一端到端上限
- 协议翻译 v1：仅 `family=openai` 且 `api=chat` 的模型；thinking/document 块丢弃；工具调用参数在流结束时整块下发（index 交错/缺失不丢，按 index 排序；混合 index/id 帧按别名合并为同一块，避免同一调用被拆成两块——前提是上游 tool_call id 全局唯一，若上游对不同调用复用同一 id 会被合并并串接参数）；流式输出 token 为估算值
- 免费优先（free-first）会**替换实际服务模型**：客户端请求 `deepseek-v4.1-flash` 可能由 `longcat-2.5-preview-free` 应答，能力差异由该模型决定（响应 `model` 字段如实呈现）；免费模型是上游的限时活动，可能随时下架（届时自动回落付费模型）；免费模型不消耗付费额度，因此面板用量曲线不会因免费流量而下降
- launchd 自启仅 macOS；代理本体跨平台

## License

MIT License. See [LICENSE](LICENSE).

Copyright (c) 2026 OpenSelect contributors.
