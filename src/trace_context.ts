import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestTrace {
  id: string;
  started: number;
  attempts: number;
  lastAttempt?: { started: number; provider: string; model: string };
  firstContentMs?: number;
  generationMs?: number;
}
export const traceContext = new AsyncLocalStorage<RequestTrace>();
