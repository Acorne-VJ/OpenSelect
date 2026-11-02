# OpenSelect 功能介绍

> 本机 **OpenCode Go 多账号池**守护服务：官方用量监控 → 阈值自动切换 → 请求级无缝故障转移，
> 外加本机双协议统一出口、免费模型优先、用量告警、应用级备份与签名。

- 版本：v0.1.x · Bun + TypeScript 单进程 · 运行时零 npm 依赖
- 代理 `:8788` · 控制台 `:8789` · 配置 `~/.openselect/config.json`（0600）· 台账 `~/.openselect/data.sqlite`

---

## 1. 它解决什么问题

| 痛点 | OpenSelect 的做法 |
|---|---|
| 多个 OpenCode Go 账号额度分散，谁快满了只能肉眼盯 | 每 45s 轮询官方 `/v1/usage`，三窗口（5 小时 / 周 / 月）用量与重置时间可视 |
| 某个账号撞到 97% 才后知后觉 | 越线自动切走（默认 97%，可调 95–99%），并保留会话亲和 |
| 单账号限流直接报错，任务中断 | 请求级故障转移：在**响应首字节到达客户端之前**换号重试，客户端无感 |
| 付费额度被白白消耗 | 免费模型优先：先用你选定的免费模型，不可用时自动回落付费 |
| Claude Code / 其它客户端接不上 | 本机统一出口：Anthropic 与 OpenAI 双协议零配置接入，必要时做协议翻译 |
| 额度快满却没人知道 | 用量告警：桌面通知 + 邮件 + 日志 + 台账，支持分档阈值与静默时段 |
| 账号 Key / 用量历史没有任何备份 | 应用级备份 + Ed25519 签名 + 私有 git remote + 每日定时备份 |

---

## 2. 架构

```
opencode / Claude Code / 任意 OpenAI 客户端
        │  baseURL → http://127.0.0.1:8788
        ▼
┌──────────────── OpenSelect 进程（launchd 常驻）────────────────┐
│  代理 :8788        路径路由 · 选号 · 故障转移 · 协议翻译 · 免鉴权   │
│  面板 :8789        账号/设置/接入/模型摘要/曲线/日志/告警/备份/统计 │
│  用量轮询 45s       官方 /v1/usage → 三窗口快照 → 选号与告警        │
└───────────┬───────────────────────────────┬────────────────────┘
            │                               │
   opencode.ai/inference/go          官方 /v1/usage
   （账号池按策略选 key）
```

---

## 3. 功能详解

### 3.1 账号池与用量监控

- 每个账号携带一个 `oc_sk_` Key（`integration=opencode-go` 的账号进切换池；其它类型只注册凭据）。
- 每 45s 并行轮询 `GET /v1/usage`，记录每个账号的 rolling / weekly / monthly：
  **percent（用量）、status（是否限流）、resetsAt（重置时刻）**。
- 面板「账号池」逐账号显示：状态徽标、三窗口进度条与重置时间、压力值、可用模型数、最近使用、HTTP 错误。默认显示全部账号；仅凭据账号单独放在 `/connect`，不混入账号池。新账号接入即启用，无手动启停；长冷却账号可手动「清除冷却」。
  重置时间取自上游 `resetsAt`（**UTC 绝对时刻**），面板按**本机时区**显示并附**倒计时**（与官方页 `Resets in Xd Yh` 同构），页面顶部标注当前时区，避免把本地时刻误当成上游时刻。
- 面板「运行设置」可调轮询间隔（10–3600s）；进程重启后自动恢复 ≤24h 的最近快照，避免"重启窗口误选已满的账号"。
- 控制台右上「统计 →」进入独立 `/stats` 页：按今天/24h/7天/30天 + 小时/天汇总**模型用量**、**账号用量**，并给出**模型×账号**、**时间×模型**、**时间×账号**矩阵；账号表同时显示当前 5h/周/月额度。统计与主控制台分页，避免单页堆叠。
- 控制台右上「模型 →」进入独立 `/models` 页：默认只显示“全部账号一致 / N 个模型有差异”的结论；只有存在差异时才自动展开明细，账号多时不再把每个账号铺成矩阵列，支持搜索与“只看差异”。主控制台只保留一行摘要和入口。
- 控制台右上「请求 →」「切换 →」进入独立日志页：请求流水支持范围/接入/账号/状态/模型/关键词过滤、100 条/页和详情；切换记录默认只看故障切换，可切「会话重绑」，按范围/账号/原因过滤。主控制台只保留最近 24h 摘要，不再铺完整表格。

### 3.2 选号策略（三级）

| 级别 | 行为 |
|---|---|
| sticky | 同一会话优先沿用上次绑定的账号（TTL 2h） |
| least-pressure | 候选账号里选压力（max 三窗口用量）最低的 |
| fallback | 全部越线/冷却时，选"最不坏"的一个继续服务（不硬失败） |

- **压力** = max(rolling, weekly, monthly)，≥100% 统一按 `PRESSURE_MAX=1.2` 饱和排序。
- **切换阈值** `switchAt` 默认 0.97（可调 0.95–0.98），与告警阈值互相独立。
- **fallback 排序**：未限流 > 未超阈值 > 冷却更短 > 压力更低。不能只按 `cooldownUntil` 排：周额度 100% 的账号 cooldown=0，会排在仅因瞬时 429 冷却 3s 的健康账号前面，导致连续撞已耗尽账号。

### 3.3 请求级无缝故障转移

> 404 补充：上游返回 404 且响应体含「Endpoint/Model is unavailable」表示**该账号的端点暂不可用**（实测同账号同模型先 404 后 200，属间歇性）。代理按「账号×模型」记 2 分钟负缓存并换号重试；**同一模型累计 3 个账号都不可用即判定为模型级不可用**，停止扫描（不把整个池扫一遍）并把 404 透传给客户端。判据只认「明确说明端点/模型不可用」的措辞（`Endpoint/Model is unavailable`、`does not exist`、`not found`、`not available` 等，且排除 route/routing/url/path 这类网关路由错误）；与模型无关的 404（如 `Not Found`、路由错误）原样透传、不换号。

在**响应首字节到达客户端之前**处理：

| 上游情况 | 处理 |
|---|---|
| 429（带 `limitName` / `retry-after`） | 按上游恢复时间冷却该账号 → 换号重试 |
| 429（裸：两者都没有） | **3s 账号短冷却**，不写模型负缓存 → 换号重试；避免并发 burst 把整池封死 |
| 401 | 标记 Key 失效（移出池）→ 换号重试 |
| 403（工作区隐私/模型级） | **不毒化账号**，按（账号×模型）负缓存 15 分钟 → 换号重试 |
| 5xx / 网络错误 / 2xx 后断流 | 冷却该账号（≤60s）→ 换号重试 |

- 单请求最多尝试 4 个账号（`maxAttempts`）。
- 成功响应也会**预读首个数据块**：正文没到就断流，同样触发换号。
- 每次切换都写 `switches` 表（from → to、原因、详情），面板「切换记录」可见。

### 3.4 免费模型中转（三种模式）

面板「免费模型」区块统一管理：**中转模式** + **选用哪些免费模型** + **优先级**（详见 3.9b）。

| 模式 | 客户端请求付费模型时 | 免费候选失败时 | 免费候选全失败时 |
|---|---|---|---|
| `关闭` | 直接用付费模型（不替换） | — | — |
| `优先` | **先**用免费候选（按优先级） | 换下一个候选（同账号继续） | 回落付费模型（按付费资格重新选号） |
| `兜底` | 平时用付费模型 | 付费模型所有账号都不可用时才用免费候选；候选失败**换账号重试同一候选**，该候选的账号耗尽才换下一个候选 | 透传最后一次失败原因 |

- 免费候选失败（429/403/404/5xx/断流/网络错误）时：记（账号×免费模型）负缓存 **15 分钟**、**不冷却账号**（付费流量不受影响）。
- **401 除外**：401 表示 Key 失效，属**账号级** → 账号移出池（与付费路径一致）。
- 客户端直接请求免费模型、或请求 anthropic/google/responses 家族 → 不替换（协议不匹配）。
- 回落时由选号器按**付费资格**重新选号（冷却/超阈值账号仍被避开）。
- 请求台账同时记录「客户端请求的模型」与「实际服务的模型」，面板显示 `请求模型 → 实际模型`。
- 兜底模式的**上游调用上界**：付费阶段 ≤ `maxAttempts` 次，免费阶段 ≤ `候选数 × 账号数` 次（受迭代上限约束）。
- 付费路径的 404「端点不可用」负缓存是 **2 分钟**（该错误实测为间歇性）；免费候选的负缓存是 **15 分钟**（同一账号上该模型大概率也不可用）。

> 实测可用的 Go 免费模型：`longcat-2.5-preview-free`、`minimax-m3.1-flash-free`（`beam-free` 地域限制）。

### 3.5 本机统一出口（双协议）

`http://127.0.0.1:8788` 同时提供：

| 协议 | 端点 | 客户端 |
|---|---|---|
| Anthropic | `POST /v1/messages`、`/v1/messages/count_tokens` | Claude Code、任意 Anthropic SDK |
| OpenAI | `POST /v1/chat/completions`、`/v1/responses` | OpenAI SDK、Open WebUI、Chatbox… |
| 清单 | `GET /v1/models`（本地返回，含 `family` / `free`） | 全部 |

- 客户端**零配置**：不需要真实 Key（任意占位串即可），认证由代理按账号池替换。
- 会话头 `x-opencode-session` 缺失时自动合成（按凭据+UA 稳定）→ 保持会话亲和。
- 上下文窗口：模型 ID 可带 `[1m]` / `[200k]` 提示（Claude Code 用），代理转发前剥离；请求超过 1,048,576 tokens 时本地返回标准 `prompt is too long`，避免把超限请求发到上游。

### 3.6 协议翻译（Anthropic → OpenAI Chat）

让 Claude Code 直接用 openai 系模型：

- 请求映射：system（字符串/块）、多轮消息、图片、tools/tool_choice、tool_result、stop_sequences。
- 响应映射：文本、tool_use（参数整块下发）、stop_reason 修正（有工具调用 → `tool_use`；`length`→`max_tokens`；`content_filter`→`end_turn`）。
- 工具流混合 index/id 帧按**别名合并**为同一块，参数完整拼接（按 numeric index 排序）。
- `count_tokens` 对非 anthropic 模型本地近似（JSON 字节 / 4），不触发推理。

已知边界：thinking/document 块丢弃；流式 `output_tokens` 为估算；工具参数在流结束时整块下发。

### 3.7 模型目录同步

- `opensel sync-catalog` 以**账号实际** `/v1/models` 为准增删 `data/models.json`（37 个模型）。
- 新模型的协议用**零推理**方式判定（靠协议边界错误码级联探测），不消耗额度。
- `--write` 写盘并自动刷新 opencode 注入；面板「模型可用性」可按账号刷新可用模型视图并标出免费模型。

### 3.8 opencode 接入（可逆）

- `opensel wire` 把 opencode 里 `opencode-go` 全部模型的**模型级** `baseURL` 指向 `http://127.0.0.1:8788`。
- 注入前自动备份到 `~/.openselect/backups/`，并把每个模型的**注入前原值**记入 `wired.json`。
- `opensel unwire` 按原值还原（注入后被手动改过的条目保持手动值）。
- 面板「opencode 接入」一键注入/撤销。

### 3.8b 接入（客户端）与按接入指定账号

**「接入」= 哪个客户端在用本代理**（与账号卡片上的 integration 不同：那是「账号属于哪种集成」）。

- 识别方式（`src/client.ts`）：显式头 `x-openselect-client`（代理内部头，不转发上游）→ User-Agent（opencode / claude-cli）→ 请求路径（`/v1/messages`、`/responses`、`/v1/chat/completions`）。
  会话头 `x-opencode-session` **不**作为判据：它是通用的会话粘性头，据此判定会把普通 OpenAI SDK 客户端误判成 opencode。
- 6 种接入：`opencode`、`Claude Code`、`Anthropic 协议客户端`、`OpenAI Responses 客户端`、`OpenAI Chat 兼容客户端`、`其他客户端`。
- 台账 `requests.client` 逐请求记录接入；面板「接入（客户端）」显示每个接入的请求数、当前实际服务的账号，并可**逐个接入指定账号**。
- 指定语义：只影响「优先」。命中账号被停用/Key 失效/限流时忽略指定，按正常策略故障转移。
- 生效优先级：**接入指定 > 全局手动指定（设为首选）> 会话粘性 > 最低压力**。
- 指定只影响「优先」：命中账号被停用、Key 失效、限流或**用量超阈值**时该指定被忽略，按正常策略故障转移（不会把流量锁死）。
- 删除账号时会一并清掉指向它的接入指定（不留幽灵引用）。
- CLI：`opensel pin list` 查看，`opensel pin <client> <account|off>` 设置/解除。

### 3.9a 免费模型从统一端口直接使用（Claude Code / OpenAI 兼容客户端）

免费模型（opencode-go 的免费额度模型）已经由本代理的**统一端口**直接提供，任意客户端都能用：

```bash
# Claude Code（Anthropic 协议，代理负责翻译）
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 ANTHROPIC_AUTH_TOKEN=openselect \
ANTHROPIC_MODEL=minimax-m3.1-flash-free CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 claude

# OpenAI 兼容客户端
# base_url=http://127.0.0.1:8788/v1   model=minimax-m3.1-flash-free
```

> `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`：Claude Code 不认识这些模型 id，会按 200k 窗口估算并提示；
> 加上它即可按上游实际窗口等待（实测请求 200 正常返回）。

- 面板「免费模型」区块每个模型旁边有 **「复制 Claude Code 命令」** 按钮（自动带上本机代理端口与模型 id）。
- 免费模型**不占账号额度**，因此「免费优先 / 兜底」模式可在额度耗尽时无缝接管。

### 3.9b opencode（zen）免费层直通中转（本地 opencode server /generate）

本机运行的 `opencode serve` 能合法访问 zen 免费层（无需伪造身份），OpenSelect 托管该 server
并通过其 HTTP API `/api/session/{id}/generate` 驱动生成。

**已在统一端口开放**：
- 协议：`/v1/chat/completions`、`/v1/messages`、`/v1/responses`（OpenAI / Anthropic / Responses 三协议）
- 支持流式（SSE）与非流式
- 模型列表 `/v1/models` 自动合并目录内的 zen 免费模型：
  `deepseek-v4.1-flash-free`、`nemotron-3-ultra-free`、`mimo-v2.6-flash-free`、`glm-5.3-flash-free`、`flint-40b-free`、`big-pickle`、`nemotron-3.5-super-vl-free`/`nemotron-3.5-lightning-free`
- 不占账号额度；作为「优先 / 兜底」模式的候选参与中转，可由面板勾选与排序

配置：`~/.openselect/config.json` 的 `zen` 段（默认启用、端口 8790、`fallbackModel` 默认 `deepseek-v4.1-flash`）

**自动轮换与故障自愈（2026-10-26 修复）**：

| 失败类型 | 行为 |
|---|---|
| 免费额度耗尽（`FreeTierError` / 429 / rate limit） | 该模型冷却 30min，换下一个 zen 候选 |
| 模型下线（`ModelDeprecated` / 410） | 该模型冷却 24h，换下一个候选 |
| 通用上游故障（`Endpoint is unavailable` / 503 / 连接失败 / server 起不来） | **不写模型冷却**，只记本次失败并换下一个候选；连续 2 个候选都遇到则整链短时熔断 8s，直接落后备，避免每个请求挨个撞 8 个模型 |
| 未知错误 | 该模型短冷却 1min |

- **server 自愈**：启动前检测端口残留并清理旧 `opencode serve`；密码解析设 12s 超时、失败自动重试一次；请求连接失败时清空托管状态，下次调用自动拉起。
- **会话隔离**：每个请求独立创建/删除 zen 会话，避免并发请求共用会话时“刚切完模型又被切走”的竞态。
- **全挂落付费**：客户端点名 zen 模型时，若所有 zen 候选失败——`优先/兜底`模式下**无缝落到 `zen.fallbackModel`**（默认 `deepseek-v4.1-flash`），会话不中断；`关闭`模式才返回 503（带各模型恢复时间）。
  台账同时记录 `model=<点名的 zen 模型>`、`served_model=<实际付费模型>`，面板「模型 → 实际服务」可见。

> 实测可用：`deepseek-v4.1-flash-free`、`nemotron-3-ultra-free`、`mimo-v2.6-flash-free`、`glm-5.3-flash-free`、`big-pickle`
> `flint-40b-free` 偶发 503（上游不稳定）

### 3.9c 为什么直接重放请求头不行（实测记录）

上游 zen 免费层原本限定「只能在 opencode 客户端内使用」（HTTP 403 FreeTierError）。
实测 8 组组合（无鉴权 / Go Key / Bearer public / 完整复刻客户端头 / 流式 / 非流式 / curl / Bun fetch）全部 403。
门槛非请求头判定（完整复刻仍被拒），成因疑似 TLS/HTTP 指纹或应用内嵌凭据。
因此**不做**冒充式中转，改用本地 opencode server 合法驱动（实测 `/generate` 稳定 3–5s）。

```
HTTP 403 {"type":"error","error":{"type":"FreeTierError",
  "message":"OpenCode's free tier can only be used from within OpenCode."}}
```

实测记录（本轮逐项验证，均为 403）：

| 尝试 | 结果 |
|---|---|
| 无鉴权 / 用 opencode-go 账号 Key | 403 |
| `authorization: Bearer public`（客户端真实用的占位凭据） | 403 |
| 完整复刻客户端请求头（`user-agent: opencode/latest/2.0.32/cli`、`x-opencode-client`、`x-opencode-project`、`x-opencode-session(-id)`、`x-session-affinity`、`x-session-id`、`b3`、`traceparent`） | 403 |
| 流式 / 非流式；curl / Bun fetch 两种 HTTP 客户端 | 403 |

结论：在本次实测的 8 组组合中门槛**不是请求头判定**（完整复刻仍被拒），成因**疑似**客户端身份证明
（TLS/HTTP 指纹或应用内嵌凭据）—— 第三方代理未能复现。因此本项目**不做**该方向的伪装中转
（若上游日后放宽，机制可另行评估）。
需要这些模型时，直接在 opencode 客户端里选用即可；通过本统一端口使用免费模型请用 opencode-go 的免费模型
（`minimax-m3.1-flash-free` / `longcat-2.5-preview-free` / `beam-free`，见 3.9a）。

### 3.9 用量告警

- 通道：**macOS 桌面通知**（异步不阻塞代理）+ **邮件**（内置极简 SMTP 客户端：应答码校验、10s 超时、头部净化防注入）+ `logs/alert.log` + 台账 `alerts` 表 + 面板「用量告警」。
- 阈值：全局 `alertAt`（默认 90/95/97%）+ **按窗口分档** `alertAtByWindow`（留空=跟随全局）。
- **静默时段** `alertQuiet`（本地时间，跨零点自动处理）：期间只记台账/日志，不发通知。
- 去重：同一次越线只告警一次；回落后解除（历史行保留），再次越线会重新告警；冷却 `alertCooldownSec`（默认 6h）防抖动。
- 同一轮轮询的多个越线项**合并成一条通知**。
- `opensel alerts` 查看告警历史。

### 3.9b 免费模型：选用、优先级与中转模式

**面板「免费模型」区块**（可编辑，不只是展示）：

| 控件 | 含义 |
|---|---|
| 中转模式 | `关闭` / `优先` / `兜底`（见下） |
| 选用（勾选） | 哪些免费模型允许参与中转（目录内全部免费模型都在列表里，勾选即生效） |
| 优先级 ↑↓ | 候选的尝试顺序：从上到下依次尝试，某个不可用就换下一个 |
| 可用账号 | 来自各账号 `/v1/models` 的实际可用性 |
| 近期中转 | 近 80 条请求里有多少条被该免费模型承接（请求模型 → 实际服务模型） |

**三种模式的语义**：

| 模式 | 行为 | 适用 |
|---|---|---|
| `关闭` | 完全不做模型替换，客户端请求什么就用什么 | 只想用自己的付费模型，不接受任何替换 |
| `优先` | 客户端请求付费模型时，**先**用选中的免费模型承接；免费候选全不可用才回落付费模型 | 优先省额度，能接受免费模型的质量 |
| `兜底` | 平时用客户端请求的付费模型；**只有付费模型所有账号都不可用**（额度用尽/限流/超阈值）时，才用选中的免费模型接着 | 质量优先，但不让会话因额度耗尽而中断（**推荐**） |

- CLI 等价：`opensel free`（查看）、`opensel free --mode fallback`、`opensel free --use id1,id2`。
- 硬约束：免费模型只在 **chat 端点**（`/v1/chat/completions`）上服务；走 **responses 端点**的客户端（opencode 默认的 `gpt-6-luna` 等）不会被免费模型承接。
- 负缓存按协议作用域隔离：某账号在 responses 端点上的失败，不会影响该模型在 chat 端点上的可用性。

- 「最近请求」表的「模型」列已能看出中转：`deepseek-v4.1-flash → longcat-2.5-preview-free`。
- 面板的编辑状态是**本地草稿**：未保存时不会被 5 秒自动刷新覆盖（保存按钮旁显示「有未保存的修改」）。

### 3.9d 直连 Z.ai / MiniMax / DeepSeek 官方 / Command Code / Ollama Cloud 与 DeepSeek Search

- **Z.ai**：`https://api.z.ai/api/anthropic`，模型 `zai/glm-5.3-flash` / `zai/glm-5.3`；`thinking.type=enabled` + `reasoning_effort=max`（默认）。
- **MiniMax**：中国区 `https://api.minimaxi.com/anthropic`，全球区 `https://api.minimax.io/anthropic`；模型 `minimax/MiniMax-M3.1-Flash` / `minimax/MiniMax-M3`；`output_config.effort=max`（默认）。
- **5h/周额度**：Z.ai `GET /api/monitor/usage/quota/limit`（unit=3/5 为 5h，unit=6/1 为周）；MiniMax `GET /v1/token_plan/remains`（`current_interval_remaining_percent` / `current_weekly_remaining_percent`）。映射到 rolling/weekly，沿用 99% 切换。
- **供应商 429**：有 `retry-after`/`limitName` 或用量 100% 才按恢复时间冷却；裸 429 只停 3 秒，避免有余额的 MiniMax 被误冷却 5 分钟。
- **DeepSeek 官方**：`https://api.deepseek.com/anthropic`，模型 `deepseek/deepseek-flash` / `deepseek/deepseek-v4-pro`；默认 `reasoning_effort=max`；`GET /user/balance` 查 CNY 余额。账号类型 `deepseek-api` 固定 `fallbackOnly`：正常轮换不选，只有其它账号/供应商都不可用时才兜底；显式 `deepseek/...` 仍可直接用。
- **Command Code**：`https://api.commandcode.ai/provider/v1`，Bearer Provider API Key；原生支持 Anthropic `/v1/messages`、OpenAI `/v1/chat/completions` 与 `/v1/responses`。短别名 `commandcode/deepseek-v4.1-flash`、`commandcode/glm-5.3-flash`、`commandcode/minimax-m3.1-flash`、`commandcode/kimi-k3.1-pro`，`cc/...` 同义；也支持 `commandcode/<厂商>/<模型>` 透传。没有公开 5h/周额度端点，用量按 0 处理，参与同 provider 多 key 故障转移。
- **Ollama Cloud**：默认 `https://ollama.com/v1`，需要 API Key；模型从 `/api/tags`（失败时 `/v1/models`）动态发现，别名为 `ollama/<模型名>`。原生支持 Anthropic `/v1/messages`、OpenAI `/v1/chat/completions`、`/v1/responses`，Bearer 认证；按量或 Pro/Max/Team credits 计费。
- **coding-auto**：Z.ai GLM-5.3-Flash → MiniMax M3.1-Flash → opencode-go deepseek-v4.1-flash → DeepSeek 官方 deepseek-flash；固定别名只在该 provider 内换 key。Command Code / Ollama Cloud 通过各自显式别名使用。
- **首页价格对比**：以 DeepSeek 官方 `deepseek-flash` 非高峰、缓存未命中、1:1 输入输出（$0.375/M）= 100%，分「套餐」「DeepSeek 订阅额度倍数」「API」三段；OpenCode Go、Command Code、Z.ai、MiniMax、Ollama Cloud 等套餐按内含额度折算，未公布美元额度的套餐标「—」，不编造比例。Ollama Cloud 按标准/off-peak 单价列入 API 表，并列入 Pro/Max/Team 订阅额度。
- **403 兜底**：opencode.ai 的 Cloudflare 1010（空 UA / Python-urllib 等 `browser_signature_banned`）通过统一上游 `User-Agent` 规避；`coding-auto` 与普通 `deepseek-v4.1-flash` 遇到 401/403/404/429/5xx 会继续落 DeepSeek 官方，仅 400/413 不重试。
- **DeepSeek Search/Fetch**：`POST /v1/tools/search`、`/v1/tools/fetch`，Key 来自 `DEEPSEEK_API_KEY` 或 `integration=deepseek` 账号；OpenCode skill 位于 `~/.config/opencode/skills/deepseek-search`。
- **一键 Claude Code 别名**：`scripts/install-claude-aliases.sh` 写入 `ds-cli`（付费 deepseek）、`free-cli`（免费链）、`auto-cli`（coding-auto）；别名只含 `ANTHROPIC_AUTH_TOKEN="openselect"` 占位，真实 Key 留在 OpenSelect config。

### 3.9e Token 消费统计（/tokens）

- **采集**：请求台账新增 `provider / input_tokens / output_tokens / cache_read_tokens / cache_write_tokens / total_tokens / token_estimated`；旧库自动增量迁移，旧请求保持 NULL。
- **协议**：解析 OpenAI Chat、Responses、Anthropic Messages、Google usageMetadata、Ollama Cloud 原生字段；流式 SSE 用透明 tap 读取 `message_start` / `message_delta` / 最终 `usage`，不改变客户端字节。
- **口径**：`input` 为未命中缓存的输入（OpenAI/Google 的 prompt 会扣掉 cached）；`total = input + cacheRead + cacheWrite + output`。
- **页面**：`/tokens` 展示总 Token、估算支出、缓存命中、活跃账号/模型、供应商消费、账号/模型排行、客户端消费、按小时/天趋势、91 天活跃度热力图与 24 小时节奏；支持今天/24h/7天/30天/全部历史。
- **诚实标注**：OpenAI→Anthropic 的流式翻译 usage 为本地估算，记为「估算」；上游未返回 usage 的请求显示「未上报」；历史无 token 的行不进入 Token 排行。估算支出按已知模型单价计算，不含订阅费/平台费/税费。

### 3.9f 线路优化与分时窗口采集（/routes）

- **供应商分时**：DeepSeek 官方高峰为周一至周五 `01:00–04:00`、`06:00–10:00 UTC`；Ollama Cloud 为周一至周五 `12:00–18:00 UTC`；Z.ai Coding Plan 为周一至周五 `14:00–18:00 SGT（UTC+8）`；MiniMax / Command Code 无公开分时折扣；OpenCode Go 的 DeepSeek V4.1 Flash / V4 Pro 与 DeepSeek 官方同窗口，高峰单价翻倍。
- **套餐分时**：Z.ai Lite/Pro/Max 非高峰 credits 50%；Ollama Cloud Pro/Max/Team 按模型 rates，非高峰 50%；OpenCode Go 的 DeepSeek 额度随官方高峰翻倍；Command Code 无分时折扣。
- **最优线路**：有效成本 = 基准 `$0.375/M` × 套餐比例 × 当前分时倍率；线路得分 = 有效成本 × `(1 + 账号压力 × 0.25 + 延迟分 × 0.15 + (1 − 质量分) × 0.20 + (1 − 可靠性) × 0.15)`；延迟与可靠性取最近 24h 该供应商平均耗时/成功率（无样本按 0.5），质量分为可配置基准；可用性优先（启用、未失效、未冷却、未限流）。
- **页面**：`/routes` 展示当前最优线路、线路排行、供应商窗口、套餐窗口、下一次切换、数据来源与采集状态；首页驾驶舱也显示一张“最优线路”卡。
- **自动采集**：`bun run collect:pricing` 或 `/routes` 页面按钮抓取官方页面；`data/time-pricing.json` 保存窗口/来源/时间；解析失败保留旧值并记录错误，不伪造窗口。

### 3.10 备份 / 恢复 / 签名 / 私有 remote

| 能力 | 命令 | 语义 |
|---|---|---|
| 异地自动备份 | `opensel backup --remote <url\|off>` + `opensel install` | 配置远端后，每日 03:30 的定时任务自动「本地备份（保留 14 份）→ 签名 → 推送」；面板「备份与签名」显示当前远端 |
|---|---|---|
| 应用级备份 | `opensel backup [--sign] [--keep N]` | 打包 `config.json`（含账号 Key）+ `data.sqlite`（`VACUUM INTO` 一致性快照）+ `wired.json` + 两个 launchd plist；归档与 sidecar 均 0600，备份目录 0700 |
| 保留策略 | 同上 | 按创建时间保留最新 14 份（CLI / 面板 / 定时任务共用同一常量），其余连同 sidecar 删除 |
| 校验 | `verifyBackup` | 归档 sha256 + 逐文件 sha256 + 归档成员集合三者一致 |
| 签名 | `opensel keygen` → `opensel backup --sign` | Ed25519 私钥签 manifest（覆盖逐文件摘要 + 成员集合）；私钥 0600 仅本机，公开钥是**信任锚**（指纹可人工核对） |
| 恢复 | `opensel restore <path\|latest> [--dry-run] [--allow-unsigned] [--yes]` | 校验 → 生成「恢复前」安全备份 → 停服务 → 原子写回（不覆盖已有好备份）→ 重启服务；**已配置信任锚时无签名归档一律拒绝**（`--allow-unsigned` 显式放行） |
| 私有 remote | `opensel backup --push/--fetch <git 远端>` | 累积式 push（远端保留历史）、`--encrypt` 加密（口令只走环境变量）、拉回时逐份校验 + 自动验签 |
| 定时备份 | launchd `com.openselect.backup` | 每日 03:30 执行 `backup --keep 14 --sign-if-possible`（有私钥则签名） |

### 3.11 历史用量快照修复

2026-10-20 之前，官方 `/v1/usage` 的低百分比曾被旧解析器放大 100 倍（2% → 200% → 面板 150%），导致账号被误判限流。
`opensel repair-usage` 定向清理**可辨识的污染行**（窗口值 ≥ 1 且状态为 `ok`；真实 100% 的窗口上游标 `rate-limited`，不会被误改），
按「存值/100」近似还原，且**只处理解析器修复时刻之前**的行。落在 (0,1) 区间的存值无法与真实值区分，保持原样（有意保守）。

### 3.12 运维与可观测

| 命令 | 用途 |
|---|---|
| `opensel doctor` | 全链体检：bun/opencode/账号 Key/代理/面板/opencode 接入/凭据服务 + 免费优先/告警/静默/邮件/信任锚/最新备份签名与验签 |
| `opensel status` | 一屏总览：端口、接入、策略、告警阈值、签名指纹、逐账号用量 |
| `opensel logs -n 20` | 最近请求与切换记录 |
| `opensel accounts` | 账号池列表与最近用量 |
| `opensel install/uninstall` | launchd 常驻 + 每日自动备份任务 |

---

## 4. 控制台页面导览（:8789）

| 区块 | 能做什么 |
|---|---|
| `/connect` 添加账号 | 填 Key + 选类型（opencode-go / Google / Anthropic / OpenAI / DeepSeek / xAI / Z.AI / MiniMax / Command Code / Ollama / 自定义）；Ollama Cloud 需要 API Key；可同时注册到 opencode 凭据 |
| `/settings` 运行设置 | 切换阈值、轮询间隔、免费优先列表、告警阈值 / 分窗口阈值 / 静默时段、自动激活凭据 |
| `/connect` opencode 接入 | 一键注入 / 撤销 + 接入指引 + 实测进池流量（opencode 是否真的把请求打进来） |
| `/connect` 仅凭据账号 | DeepSeek Search / Google / Anthropic / OpenAI / xAI 等只注册凭据，不混入账号池、不显示用量 |
| 当前连接 | 正在服务的账号、手动指定（可解除）、活跃会话数与绑定明细 |
| `/connect` 接入（客户端） | 每个接入的请求数、当前实际服务账号、逐接入指定账号 |
| 模型可用性 | 按账号刷新实际可用模型，标出免费模型 |
| 价格对比 | 以 DeepSeek 官方 API = 100%，分「套餐」「DeepSeek 订阅额度倍数」「API」三段；含 OpenCode Go、Command Code、Z.ai、MiniMax、Ollama Cloud 等，附来源与日期 |
| Token 统计 | `/tokens`：总 Token / 估算支出 / 缓存命中 / 活跃账号模型；按供应商、账号、模型、客户端、时间聚合 |
| 线路优化 | `/routes`：供应商/套餐分时窗口、最优线路、有效成本、账号压力、下一次切换、自动采集 |
| `/` 账号池 | 默认显示全部；逐账号三窗口进度条、重置时间、压力、最近使用、HTTP 错误、套餐档位下拉、删除；接入即启用，无手动启停 |
| 切换记录 | 谁换到谁、原因、详情 |
| 最近请求 | 接入、模型（请求→实际）、家族、账号、状态、尝试数、耗时、路径 |
| 用量告警 | 告警历史（时间/账号/窗口/阈值/用量） |
| 备份与签名 | 归档列表（签名/验签列）、信任锚指纹、立即备份 / 备份并签名 |

---

## 5. 典型用法

**A. Claude Code 走本机池（并优先用免费模型）**

```bash
alias ds-cli='export ANTHROPIC_BASE_URL="http://127.0.0.1:8788" ANTHROPIC_AUTH_TOKEN="openselect" ANTHROPIC_MODEL="deepseek-v4.1-flash"; claude --permission-mode bypassPermissions'
```

**B. 任何 OpenAI 客户端**

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8788/v1" OPENAI_API_KEY=openselect
```

**C. 跨机恢复**

```bash
# 机器 A
opensel backup --push git@host:me/openselect-backups.git --sign --yes
# 机器 B（需同一份公开钥 / 指纹核对）
opensel backup --fetch git@host:me/openselect-backups.git
opensel restore latest --yes
```

---

## 6. 配置速查（`~/.openselect/config.json`）

```jsonc
{
  "proxy":    { "host": "127.0.0.1", "port": 8788 },
  "dashboard":{ "host": "127.0.0.1", "port": 8789 },
  "policy": {
    "switchAt": 0.97,            // 切换阈值（0.95–0.99）
    "maxAttempts": 4,             // 单请求最多尝试的账号数
    "cooldownFallbackSec": 300,   // 无 retry-after 时的冷却
    "sessionTtlSec": 7200,        // 会话亲和 TTL
    "freeFirst": ["longcat-2.5-preview-free"],  // 免费优先候选（有序）
    "alertAt": [0.9, 0.95, 0.97],// 全局告警阈值
    "alertAtByWindow": { "weekly": [0.95] },    // 分窗口覆盖（留空=跟随全局）
    "alertQuiet": { "from": "23:00", "to": "07:00" },  // 静默时段
    "alertCooldownSec": 21600,    // 同档两次告警最小间隔
    "alertEmail": { "to": ["ops@example.com"], "from": "me@example.com", "host": "127.0.0.1", "port": 25 }
  },
  "monitor": { "pollSec": 45 },
  "opencode": { "autoActivate": true }
}
```

---

## 7. 已知边界

- 免费模型质量与上下文窗口由模型本身决定（响应里的 `model` 字段会如实显示实际服务模型）。
- 协议翻译丢弃 thinking/document 块；流式输出 token 数为估算；工具参数在流结束时整块下发。
- 免费模型的 429 由上游按模型/账号维度下发，OpenSelect 只能观察并回落，不能预知。
- 备份签名保证**来源**，不保证**新鲜度**（旧的**有效**签名归档理论上可被回放）。
- 邮件通道为**明文 SMTP**，建议仅用于本机/内网自建。
- 端到端"无字节"静默上限约 255s（`Bun.serve` 限制），长思考流需持续有输出。
