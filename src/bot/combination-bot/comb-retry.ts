/**
 * Retry helper for combination-bot only (no dependency on other bots).
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeMsg(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function isTransientError(err: unknown): boolean {
  const anyErr = err as Record<string, unknown>;
  const msg = normalizeMsg(err).toLowerCase();
  const code = String(anyErr?.code ?? "").toUpperCase();
  const status =
    Number(anyErr?.status) ||
    Number(anyErr?.statusCode) ||
    Number((anyErr?.response as any)?.status) ||
    Number((anyErr?.response as any)?.statusCode);
  const bCode =
    Number(anyErr?.code) ??
    Number((anyErr?.body as any)?.code) ??
    Number((anyErr?.response as any)?.data?.code);

  const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ENOTFOUND", "ENETUNREACH"]);
  if (networkCodes.has(code)) return true;
  if (msg.includes("timeout") || msg.includes("socket hang up") || msg.includes("network error")) return true;
  if (status === 429 || (typeof status === "number" && status >= 500 && status < 600)) return true;
  if (bCode === -1003 || bCode === -1021) return true;
  if (msg.includes("too many requests") || msg.includes("rate limit") || msg.includes("recvwindow")) return true;
  return false;
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    minDelayMs?: number;
    label?: string;
    isTransientError?: (err: unknown) => boolean;
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown; label?: string }) => void;
  } = {}
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 5);
  const minDelayMs = Math.max(500, options.minDelayMs ?? 5000);
  const classifier = options.isTransientError ?? isTransientError;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const remaining = retries - (attempt - 1);
      if (!classifier(err) || remaining <= 0) throw err;
      const delayMs = minDelayMs * Math.pow(1.5, attempt - 1);
      options.onRetry?.({ attempt, delayMs, error: err, label: options.label });
      await sleep(delayMs);
    }
  }
}
