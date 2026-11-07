import { codingAutoOrder, type CodingAutoStep, type RoutingMode } from "./coding_auto";
import { capabilityRejections, ROUTE_CAPABILITIES, type RequestRequirements } from "./route_capabilities";
import { accountPressure, eligibility } from "./policy";
import { getDb } from "./db";
import type { Runtime } from "./state";

export const ROUTE_TARGETS: Record<CodingAutoStep, { integration: string; model: string; alias: string; scope: string }> = {
  opencode: { integration: "opencode-go", model: "deepseek-v4.1-flash", alias: "deepseek-v4.1-flash", scope: "chat" },
  zai: { integration: "zai", model: "glm-5.3-flash", alias: "zai/glm-5.3-flash", scope: "anthropic" },
  minimax: { integration: "minimax", model: "MiniMax-M3.1-Flash", alias: "minimax/MiniMax-M3.1-Flash", scope: "anthropic" },
  deepseek: { integration: "deepseek-api", model: "deepseek-flash", alias: "deepseek/deepseek-flash", scope: "anthropic" },
};

type Metric = { provider: string; samples: number; wait: number | null; duration: number; success: number };
const metricsCache = new WeakMap<Runtime, { at: number; rows: Metric[] }>();
const orderingCache = new WeakMap<Runtime, { at: number; signature: string; order: CodingAutoStep[]; scores: Map<string, number> }>();

function metrics(rt: Runtime): Metric[] {
  const cached = metricsCache.get(rt);
  if (cached && Date.now() - cached.at < 30000) return cached.rows;
  const rows = getDb().query(`SELECT a.provider, COUNT(*) samples, AVG(a.header_ms) wait,
    AVG(a.header_ms+CASE WHEN a.ordinal=t.attempts AND t.status>=200 AND t.status<300 THEN COALESCE(t.generation_ms,0) ELSE 0 END) duration,
    AVG(CASE WHEN a.header_status>=200 AND a.header_status<300 AND a.ordinal=t.attempts AND t.status>=200 AND t.status<300 THEN 1.0 ELSE 0 END) success
    FROM request_attempts a JOIN request_traces t ON t.id=a.trace_id
    WHERE t.started_at>=? AND t.state IN ('complete','failed')
    AND a.model IN ('deepseek-v4.1-flash','glm-5.3-flash','MiniMax-M3.1-Flash','deepseek-flash') GROUP BY a.provider`).all(Date.now() - 1800000) as Metric[];
  metricsCache.set(rt, { at: Date.now(), rows }); return rows;
}

/** Read-only: no probes, session rebinding, cooldown mutation, or API credentials. */
export function buildRoutingPlan(rt: Runtime, requirements: RequestRequirements, client = "other", session: string | null = null, commitOrder = false) {
  const now = Date.now(), configured = codingAutoOrder(rt.config.policy.codingAutoOrder);
  const mode: RoutingMode = rt.config.policy.routingMode ?? "manual";
  const observed = mode === "manual" ? [] : metrics(rt);
  const rows = configured.map((route) => {
    const target = ROUTE_TARGETS[route];
    const reasons = capabilityRejections(ROUTE_CAPABILITIES[route], requirements);
    const accounts = rt.config.accounts.filter((a) => a.integration === target.integration).map((a) => {
      const state = eligibility(a, rt.states.get(a.id), rt.usages.get(a.id), { free: false, now, switchAt: rt.config.policy.switchAt });
      const denied = rt.modelDeny.get(`${a.id}:${target.model}:${target.scope}`);
      const reason = !state.eligible ? state.reason : a.fallbackOnly && route !== "deepseek" ? "fallback-only" :
        a.models?.length && !a.models.includes(target.model) && !a.models.includes(target.alias) ? "model-not-enabled" :
          denied && denied.until > now ? "model-denied" : "ok";
      return { id: a.id, label: a.label, eligible: reason === "ok", reason, pressure: accountPressure(rt.usages.get(a.id)), lastUsed: rt.states.get(a.id)?.lastUsed ?? 0 };
    });
    const eligible = accounts.filter((a) => a.eligible).sort((a,b) => a.pressure-b.pressure || a.lastUsed-b.lastUsed);
    const pinned = rt.config.policy.clientAccounts?.[client], sticky = rt.getSessionAccount(session);
    const selected = eligible.find((a) => a.id === pinned) ?? eligible.find((a) => a.id === rt.forcedAccountId) ?? eligible.find((a) => a.id === sticky) ?? eligible[0];
    const metric = observed.find((m) => m.provider === target.integration);
    const c = rt.catalog.models[target.alias]?.cost;
    const referenceCost = c ? (c.input * 4 + c.output) / 5 : null;
    const score = mode === "cost" ? referenceCost : metric && metric.samples >= 5 ?
      mode === "speed" ? (metric.wait ?? metric.duration) + metric.duration * .25 + (1-metric.success)*60000 : 1 - metric.success : null;
    return { route, reasons, compatible: reasons.length === 0, available: reasons.length === 0 && !!selected,
      accounts, selectedAccount: selected?.id ?? null, selectionReason: selected ? selected.id === pinned ? "client-pinned" : selected.id === rt.forcedAccountId ? "forced" : selected.id === sticky ? "sticky" : "least-pressure" : null,
      samples: metric?.samples ?? 0, score, referenceCost };
  });
  let order = [...configured];
  let held = false;
  if (mode !== "manual") {
    const signature = JSON.stringify([configured,mode]);
    const scored = rows.filter((r) => r.available).sort((a,b) => (a.score ?? Infinity)-(b.score ?? Infinity) || configured.indexOf(a.route)-configured.indexOf(b.route));
    const proposed = scored.map((r) => r.route).concat(configured.filter((id) => !scored.some((r) => r.route === id)));
    const previous = orderingCache.get(rt);
    const scores = new Map(rows.flatMap((r) => r.score == null ? [] : [[r.route, r.score] as const]));
    const oldFirst = previous?.order.find((id) => rows.find((r) => r.route === id)?.available);
    const newFirst = proposed.find((id) => rows.find((r) => r.route === id)?.available);
    const currentScore = oldFirst ? scores.get(oldFirst) : undefined, newScore = newFirst ? scores.get(newFirst) : undefined;
    if (previous?.signature === signature && oldFirst && newFirst && oldFirst !== newFirst &&
      (now - previous.at < 60000 || (currentScore != null && newScore != null && newScore >= currentScore * .85))) {
      order = [oldFirst, ...proposed.filter((r) => r !== oldFirst)]; held = true;
    } else order = proposed;
    if (commitOrder && (!previous || previous.signature !== signature || previous.order[0] !== order[0])) orderingCache.set(rt, { at: now, signature, order, scores });
  }
  const executionOrder = order.filter((id) => rows.find((r) => r.route === id)?.compatible);
  return { mode, configuredOrder: configured, executionOrder, selectedRoute: executionOrder.find((id) => rows.find((r) => r.route === id)?.available) ?? null,
    held, switchAt: rt.config.policy.switchAt, rows: order.map((id) => rows.find((r) => r.route === id)!),
    costBasis: "Catalogue reference: 80% uncached input / 20% output; excludes subscriptions and cache discounts. Not a bill.", sampledAt: metricsCache.get(rt)?.at ?? now };
}
