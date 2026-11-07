import { ROUTE_CAPABILITIES } from "./route_capabilities";
import { codingAutoOrder } from "./coding_auto";
import type { Runtime } from "./state";

/** All generated client configurations use the same conservative route envelope. */
export function clientModelProfile(rt: Runtime) {
  const routes = codingAutoOrder(rt.config.policy.codingAutoOrder);
  const contexts = routes.map((route) => ROUTE_CAPABILITIES[route].contextTokens);
  return {
    id: "coding-auto", name: "Coding Auto", contextWindow: contexts.length && contexts.every((n) => n != null) ? Math.min(...contexts as number[]) : null,
    maxTokens: 32768, input: routes.some((r) => Array.isArray(ROUTE_CAPABILITIES[r].imageSources)) ? ["text", "image"] : ["text"],
    reasoning: routes.length > 0 && routes.every((r) => ROUTE_CAPABILITIES[r].thinking === true),
  };
}
