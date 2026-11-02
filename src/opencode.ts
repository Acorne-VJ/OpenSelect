import { spawnSync } from "node:child_process";

export interface OpencodeCredential {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value?: unknown;
}

export interface OpencodeRunResult {
  ok: boolean;
  out: string;
  err: string;
  status: number | null;
}

export function runOpencode(args: string[], timeoutMs = 30000): OpencodeRunResult {
  try {
    const p = spawnSync("opencode", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "true" },
    });
    return { ok: p.status === 0, out: p.stdout ?? "", err: p.stderr ?? "", status: p.status };
  } catch (e) {
    return { ok: false, out: "", err: String(e), status: null };
  }
}

/** `opencode api <METHOD path> [-d body]` */
export function runOpencodeApi(args: string[], timeoutMs = 30000): OpencodeRunResult {
  return runOpencode(["api", ...args], timeoutMs);
}

export function opencodeVersion(): string | null {
  const r = runOpencode(["--version"], 10000);
  return r.ok ? r.out.trim() : null;
}

export function listCredentials(): OpencodeCredential[] | null {
  const r = runOpencodeApi(["GET", "/api/credential"]);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out) as { data?: OpencodeCredential[] };
    return Array.isArray(j.data) ? j.data : [];
  } catch {
    return null;
  }
}

export function connectKey(
  integrationId: string,
  key: string,
  label?: string,
): { ok: boolean; detail: string } {
  const body = JSON.stringify({ key, ...(label ? { label } : {}) });
  const r = runOpencodeApi(["POST", `/api/integration/${integrationId}/connect/key`, "-d", body]);
  return { ok: r.ok, detail: r.ok ? r.out.trim().slice(0, 200) : r.err.trim() || r.out.trim() };
}

export function activateCredential(credentialId: string): { ok: boolean; detail: string } {
  const r = runOpencodeApi(["POST", `/api/credential/${encodeURIComponent(credentialId)}/activate`]);
  return { ok: r.ok, detail: r.ok ? "ok" : r.err.trim() || r.out.trim() };
}
