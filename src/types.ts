export type Integration = "opencode-go" | (string & {});

/** 供应商直连账号的推理强度。 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Account {
  /** stable slug id, e.g. "go-01" */
  id: string;
  label: string;
  integration: Integration;
  /** raw API key (oc_sk_...); config file is 0600 */
  key: string;
  enabled: boolean;
  note?: string;
  addedAt: number;
  /** 直连供应商（zai/minimax）的 Anthropic base；缺省按 integration/region 推导 */
  baseUrl?: string;
  /** MiniMax 区域：cn=api.minimaxi.com / global=api.minimax.io */
  region?: "cn" | "global";
  /** 该账号默认推理强度；模型别名未指定时使用，默认 max */
  defaultEffort?: Effort;
  /** 可选：该账号只承接这些上游模型 ID（缺省=该供应商全部模型） */
  models?: string[];
  /** 套餐档位（如 opencode-go / zai-max / ollama-pro）；用于线路成本与可用性 */
  plan?: string;
  /** 仅兜底：正常轮换不选它，只有其它账号/供应商都不可用时才使用 */
  fallbackOnly?: boolean;
}

export interface PolicyConfig {
  /** switch-away threshold within [0.95, 0.99], default 0.97 */
  switchAt: number;
  /** max distinct accounts tried per client request */
  maxAttempts: number;
  /** fallback cooldown when 429 has no retry-after */
  cooldownFallbackSec: number;
  /** session -> account affinity TTL */
  sessionTtlSec: number;
  /**
   * 有序免费模型候选列表：客户端请求付费模型时，先按此顺序让免费模型承接；
   * 免费模型不可用（429/403/404/400）时自动回落到原请求的付费模型。
   * 缺省视为空（关闭免费优先）。
   */
  freeFirst?: string[];
  /**
   * 免费模型的使用模式：
   * - "off"      不做任何替换（客户端请求什么就用什么，质量完全由你决定）
   * - "first"    先用选中的免费模型承接，再回落付费模型（省额度，但质量按免费模型）
   * - "fallback" 平时用客户端请求的付费模型；只有付费模型**所有账号都不可用**
   *               （额度用尽 / 限流 / 超阈值）时，才用免费模型接着，不让会话中断
   */
  freeFirstMode?: "off" | "first" | "fallback";
  /**
   * 用量告警阈值（0..1 比例），任一窗口越过即告警；缺省 [0.90, 0.95, 0.97]。
   * 与 switchAt（切换阈值）互相独立：后者决定换号，本项只负责提醒。
   */
  alertAt?: number[];
  /** 告警最小间隔（秒）：同一档阈值在持续越线期间只告警一次 */
  alertCooldownSec?: number;
  /**
   * 手动指定的账号（面板「设为首选」）：新流量优先走它；null/未设=按自然策略选号。
   * 只影响"优先"，若该账号被禁用/Key 失效则自动回退到自然策略。
   */
  forcedAccountId?: string | null;
  /**
   * 按接入（客户端）指定账号：{"opencode": "<accountId>", ...}。
   * 优先级高于 forcedAccountId（更具体的规则先匹配）；命中账号被停用/Key 失效时自动回退。
   */
  clientAccounts?: Record<string, string>;
  /** 按窗口分档阈值（覆盖全局 alertAt；留空 = 跟随全局） */
  alertAtByWindow?: Partial<Record<"rolling" | "weekly" | "monthly", number[]>>;
  /** 静默时段（本地时间 HH:MM，跨零点自动处理）：静默期间只记台账/日志，不发通知 */
  alertQuiet?: { from: string; to: string };
  /** 邮件通道：极简 SMTP（明文传输，建议内网自建） */
  alertEmail?: { to: string[]; from: string; host: string; port: number };
}

export interface Config {
  version: number;
  upstream: { base: string };
  proxy: { host: string; port: number };
  dashboard: { host: string; port: number };
  policy: PolicyConfig;
  monitor: { pollSec: number };
  opencode: { autoActivate: boolean };
  /**
   * 备份相关的持久化设置。
   * remote = 异地备份的 git 远端（定时备份任务会推送到它）；null/未设 = 只做本地备份。
   */
  backup?: { remote?: string | null };
  /**
   * opencode zen 免费层直通设置。
   * enabled = 是否启用（默认 true）；port = 本地 opencode serve 监听端口（默认 8790）；
   * fallbackModel = zen 全部不可用时无缝落到的付费模型（默认 deepseek-v4.1-flash）。
   * 该通道不占账号额度、不受切换阈值影响，直接走本地 opencode server /generate。
   */
  zen?: { enabled?: boolean; port?: number; fallbackModel?: string };
  accounts: Account[];
}

export interface UsageWindow {
  status: string; // "active" | "rate-limited" | ...
  /** 0..1 */
  percent: number;
  resetsAt: string | null;
}

export interface AccountUsage {
  accountId: string;
  ts: number;
  rolling: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
  /** 直连按量计费供应商（DeepSeek 官方）的账户余额；其他供应商为 null/undefined */
  balance?: { currency: string; total: number; available: boolean } | null;
}

export interface AccountState {
  accountId: string;
  cooldownUntil: number; // epoch ms; 0 = none
  lastError: string | null;
  lastUsed: number; // epoch ms; 0 = never
  invalid: boolean;
}

export type Family = "openai" | "anthropic" | "google";

export interface ModelInfo {
  id: string;
  name: string;
  family: Family;
  /** openai 家族子协议：缺省 "chat"（/openai/v1/chat/completions）；"responses" 表示仅 /openai/v1/responses（如 grok-4.7/gpt-*-luna） */
  api?: "chat" | "responses";
  free: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    tiers?: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
  };
  /** 直连供应商（opencode-go 之外的 provider 路由） */
  provider?: "opencode-go" | "zai" | "minimax" | "deepseek" | "commandcode" | "ollama" | "auto";
  /** 实际发给上游的模型 ID（别名与上游不同时使用） */
  upstreamModel?: string;
  /** 该模型的默认推理强度 */
  defaultEffort?: Effort;
}

export interface PlanLimit {
  modelId: string;
  name: string;
  /** monthly usage limit in USD on "Go" */
  go: number | null;
  /** monthly usage limit in USD on "Go Plus" */
  plus: number | null;
  free: boolean;
  note?: string;
}

export interface RequestLogEntry {
  /** 接入（客户端）种类：opencode / claude-code / ...（见 src/client.ts） */
  client?: string | null;
  ts: number;
  sessionId: string | null;
  model: string | null;
  /** 实际服务的模型（免费优先替换时与 model 不同；未替换则为空） */
  servedModel?: string | null;
  family: Family;
  accountId: string;
  /** 实际供应商 integration（opencode-go / zai / minimax / deepseek-api / commandcode / ollama / zen 等）。 */
  provider?: string | null;
  status: number;
  attempts: number;
  latencyMs: number;
  error: string | null;
  path: string;
  /** 未命中缓存的输入 token */
  inputTokens?: number | null;
  /** 输出 token */
  outputTokens?: number | null;
  /** 命中缓存的输入 token */
  cacheReadTokens?: number | null;
  /** 写入缓存的输入 token */
  cacheWriteTokens?: number | null;
  /** 总 token（input + cacheRead + cacheWrite + output） */
  totalTokens?: number | null;
  /** usage 是否来自本地估算（流式翻译路径） */
  tokenEstimated?: boolean | null;
}

export interface SwitchLogEntry {
  ts: number;
  sessionId: string | null;
  fromAccount: string | null;
  toAccount: string | null;
  reason: string;
  detail: string | null;
}
