/**
 * Resilient JSON fetch for client-side polling.
 *
 * Guards against every transient condition so auto-scan never surfaces a raw
 * error to the user:
 *   - hosting proxy answering with an HTML page during a restart window
 *     (previously: "Unexpected token '<', \"<!doctype \"... is not valid JSON")
 *   - engine briefly busy / restarting (503/529/429 JSON)
 *   - cold-start latency after the host wakes up
 *
 * Transient conditions are retried with backoff before giving up, and the
 * final error is always a soft, human-readable state so the UI can keep the
 * last good payload on screen.
 */

export class TransientFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientFeedError";
  }
}

const SOFT_MESSAGE = "Reconnecting to engine — last live data shown";

async function fetchOnce<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new TransientFeedError(SOFT_MESSAGE);
  }

  const ct = res.headers.get("content-type") ?? "";

  // Any non-JSON answer (proxy error page, dev overlay) is a transient state.
  if (!ct.includes("application/json")) {
    throw new TransientFeedError(SOFT_MESSAGE);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TransientFeedError(SOFT_MESSAGE);
  }

  if (!res.ok) {
    const msg =
      (body as { error?: string })?.error ?? (body as { message?: string })?.message ?? null;
    if (res.status >= 500 || res.status === 429) {
      throw new TransientFeedError(SOFT_MESSAGE);
    }
    const err = new Error(msg ?? `HTTP ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return body as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON with automatic retry/backoff for transient conditions.
 * Real 4xx conditions (e.g. symbol not found) throw immediately — only
 * restart/busy states are retried.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const DELAYS = [900, 2500, 5000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
    try {
      return await fetchOnce<T>(url, init);
    } catch (e) {
      if (!(e instanceof TransientFeedError)) throw e;
      lastErr = e;
      if (attempt < DELAYS.length) await sleep(DELAYS[attempt]);
    }
  }
  throw lastErr;
}

/** Map any thrown condition to a displayable, non-technical message. */
export function describeFetchError(e: unknown): string {
  if (e instanceof TransientFeedError) return e.message;
  if (e instanceof Error) {
    if (/not valid json|unexpected token|json/i.test(e.message)) return SOFT_MESSAGE;
    return e.message;
  }
  return SOFT_MESSAGE;
}
