import { getDb } from "./db";
import { tapUsageStream } from "./tokens";
import { traceContext, type RequestTrace } from "./trace_context";

function telemetry(write: () => void): void {
  try { write(); } catch { console.warn("[openselect] request trace telemetry unavailable"); }
}

/** Records only routing metadata, never request bodies, headers, or credentials. */
export async function tracedFetch(url: string, init: RequestInit & { timeout?: number }, meta: { provider: string; model: string; accountId: string }): Promise<Response> {
  const trace = traceContext.getStore();
  if (!trace) return fetch(url, init);
  const ordinal = ++trace.attempts, started = Date.now();
  trace.lastAttempt = { started, provider: meta.provider, model: meta.model };
  telemetry(() => { getDb().query(`INSERT INTO request_attempts (trace_id, ordinal, started_at, provider, model, account_id) VALUES (?,?,?,?,?,?)`)
    .run(trace.id, ordinal, started, meta.provider, meta.model, meta.accountId);
    getDb().query("UPDATE request_traces SET attempts=? WHERE id=?").run(ordinal,trace.id);
  });
  const finish = (status: number) => telemetry(() => { getDb().query(`UPDATE request_attempts SET header_status=?, header_ms=? WHERE trace_id=? AND ordinal=?`)
    .run(status, Date.now() - started, trace.id, ordinal); });
  try { const response = await fetch(url, init); finish(response.status); return response; }
  catch (error) { finish(0); throw error; }
}

/** One outer lifecycle spans all recursive provider fallbacks and stream reads. */
export async function withRequestTrace(req: Request, handler: () => Promise<Response>): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (traceContext.getStore() || req.method !== "POST" || path.endsWith("/count_tokens") || path.includes("/tools/")) return handler();
  const trace: RequestTrace = { id: crypto.randomUUID(), started: Date.now(), attempts: 0 };
  return traceContext.run(trace, async () => {
    telemetry(() => { getDb().query(`INSERT INTO request_traces (id, started_at, path, state, attempts) VALUES (?,?,?,'active',0)`)
      .run(trace.id, trace.started, new URL(req.url).pathname); });
    let finished = false, streamError = false;
    const finish = (status: number, state: string) => {
      if (finished) return; finished = true;
      const retry = trace.attempts > 1 && trace.lastAttempt ? trace.lastAttempt.started - trace.started : 0;
      telemetry(() => { getDb().query(`UPDATE request_traces SET state=?, status=?, duration_ms=?, attempts=?, final_provider=?, final_model=?, first_content_ms=?, generation_ms=?, retry_ms=? WHERE id=?`)
        .run(state, status, Date.now() - trace.started, trace.attempts, trace.lastAttempt?.provider ?? null, trace.lastAttempt?.model ?? null,
          trace.firstContentMs ?? null, trace.generationMs ?? null, retry, trace.id); });
      if (state === "complete" && status >= 200 && status < 300) telemetry(() => {
        getDb().query(`UPDATE requests SET duration_ms=?, first_content_ms=?, generation_ms=?, retry_ms=?, attempts=?
          WHERE id=(SELECT MAX(id) FROM requests WHERE trace_id=? AND status>=200 AND status<300)`)
          .run(Date.now()-trace.started,trace.firstContentMs??null,trace.generationMs??null,retry,trace.attempts,trace.id);
      });
      if (state === "failed" || state === "cancelled") telemetry(() => {
        getDb().query("UPDATE requests SET duration_ms=NULL WHERE trace_id=? AND status>=200 AND status<300").run(trace.id);
      });
    };
    let response: Response;
    try { response = await handler(); } catch {
      finish(500, "failed");
      return Response.json({error:{type:"api_error",message:"Internal proxy error"}},{status:500,headers:{"x-openselect-request-id":trace.id}});
    }
    const headers = new Headers(response.headers);
    headers.set("x-openselect-request-id", trace.id);
    if (!response.body) { finish(response.status, "complete"); return new Response(null, { status: response.status, headers }); }
    const tapped = tapUsageStream(response.body, () => {}, false, () => finish(streamError?502:response.status, streamError?"failed":"complete"), (first, last) => {
      trace.firstContentMs = first - trace.started;
      trace.generationMs = last > first ? last - first : undefined;
    },()=>{streamError=true;}).getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await tapped.read();
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { finish(502, "failed"); controller.error(error); }
      },
      async cancel(reason) { finish(499, "cancelled"); await tapped.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  });
}

export function readTraces(id?: string) {
  const db = getDb();
  const traces = id ? db.query("SELECT * FROM request_traces WHERE id=?").all(id) : db.query("SELECT * FROM request_traces ORDER BY started_at DESC LIMIT 30").all();
  const totals = db.query(`SELECT COUNT(*) logical_requests, SUM(attempts) upstream_attempts FROM request_traces WHERE started_at>=?`).get(Date.now() - 86400_000);
  const attempts = id ? db.query("SELECT ordinal, started_at, provider, model, header_status, header_ms FROM request_attempts WHERE trace_id=? ORDER BY ordinal").all(id) : [];
  return { traces, attempts, totals };
}
