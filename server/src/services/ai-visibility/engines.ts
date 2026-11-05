const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 120_000;

export class EngineError extends Error {
  constructor(message: string, readonly status?: number, public costUsd?: number) {
    super(message);
    this.name = new.target.name;
  }
}
export class RateLimitError extends EngineError {
  constructor(readonly retryAfterMs?: number, costUsd?: number) { super("Rate limited (HTTP 429)", 429, costUsd); }
}
export class QuotaError extends EngineError {
  constructor(status?: number, costUsd?: number) { super("Out of credits or quota", status, costUsd); }
}
export class EmptyAnswerError extends EngineError {
  constructor(costUsd?: number) { super("The engine returned an empty answer", 200, costUsd); }
}

export type EngineAnswer = { answer: string; citations: { url: string; title?: string }[]; costUsd: number; model: string };
export type AskArgs = { apiKey: string; model: string; question: string; signal?: AbortSignal };

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const QUOTA_TEXT = /credit|quota/i;

/** One web-searching answer from an OpenRouter model, with its cited URLs and cost. Error text never echoes the body. */
export async function askEngine(args: AskArgs & { fetchImpl?: typeof fetch }): Promise<EngineAnswer> {
  const signal = args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await (args.fetchImpl ?? fetch)(OPENROUTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: "user", content: args.question }],
        plugins: [{ id: "web" }],
        usage: { include: true },
      }),
      signal,
    });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    throw new EngineError(signal.aborted ? "Request timed out" : "Request failed");
  }

  let body: any = null;
  let text = "";
  try { text = await res.text(); body = JSON.parse(text); } catch { /* non-JSON body */ }
  const cost = Number(body?.usage?.cost);
  const costUsd = Number.isFinite(cost) && cost > 0 ? cost : 0;
  const withCost = <E extends EngineError>(e: E) => { if (costUsd > 0) e.costUsd = costUsd; return e; };

  const fail = (status: number, message: string) => {
    if (status === 402 || QUOTA_TEXT.test(message)) return withCost(new QuotaError(status));
    if (status === 429) return withCost(new RateLimitError(retryAfterMs(res.headers)));
    return withCost(new EngineError(`HTTP ${status}`, status));
  };
  if (!res.ok) throw fail(res.status, typeof body?.error?.message === "string" ? body.error.message : text.slice(0, 500));
  // OpenRouter can answer 200 with an error object and no choices.
  if (body?.error && !body?.choices?.length) {
    throw fail(Number(body.error.code) || 502, String(body.error.message ?? ""));
  }

  const message = body?.choices?.[0]?.message;
  const answer = typeof message?.content === "string" ? message.content.trim() : "";
  if (!answer) throw withCost(new EmptyAnswerError());

  const seen = new Set<string>();
  const citations: { url: string; title?: string }[] = [];
  const add = (url: unknown, title?: unknown) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    citations.push(typeof title === "string" && title ? { url, title } : { url });
  };
  for (const a of Array.isArray(message?.annotations) ? message.annotations : []) {
    if (a?.type === "url_citation" || a?.url_citation) add(a.url_citation?.url, a.url_citation?.title);
  }
  for (const c of Array.isArray(body?.citations) ? body.citations : []) add(typeof c === "string" ? c : c?.url);
  return { answer, citations, costUsd, model: typeof body?.model === "string" ? body.model : args.model };
}
