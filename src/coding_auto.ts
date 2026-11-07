/** Ordered routing steps for the coding-auto model. */
export const CODING_AUTO_STEPS = ["zai", "minimax", "opencode", "deepseek"] as const;
export type CodingAutoStep = (typeof CODING_AUTO_STEPS)[number];
export const ROUTING_MODES = ["manual", "speed", "cost", "stable"] as const;
export type RoutingMode = typeof ROUTING_MODES[number];

export function isCodingAutoOrder(value: unknown): value is CodingAutoStep[] {
  return Array.isArray(value) && value.length > 0 && value.length <= CODING_AUTO_STEPS.length &&
    value.every((step) => typeof step === "string" && (CODING_AUTO_STEPS as readonly string[]).includes(step)) &&
    new Set(value).size === value.length;
}

/** Missing configuration retains the historical chain; corrupt explicit configuration fails closed. */
export function codingAutoOrder(value: unknown): CodingAutoStep[] {
  if (value === undefined) return [...CODING_AUTO_STEPS];
  return isCodingAutoOrder(value) ? [...value] : [];
}
