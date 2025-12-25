type RetryOptions = {
  /**
   * Number of retries AFTER the initial attempt.
   * Example: retries=5 => up to 6 total attempts.
   */
  retries?: number;
  /** Minimum delay between attempts (ms). */
  minDelayMs?: number;
  /** Maximum delay cap (ms). */
  maxDelayMs?: number;
  /** Exponential backoff multiplier. */
  backoffFactor?: number;
  /** Add up to this fraction of jitter to the delay (0.2 => +/-20%). */
  jitterRatio?: number;
  /** Optional label to add context to logs. */
  label?: string;
  /** Override transient classification. */
  isTransientError?: (err: unknown) => boolean;
  /** Hook invoked before sleeping for the next attempt. */
  onRetry?: (info: {
    attempt: number; // 1-based attempt number (including the first attempt)
    remainingRetries: number;
    delayMs: number;
    error: unknown;
    label?: string;
  }) => void;
};

export function sleep(ms: number): Promise<void> {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

function getNumber(val: any): number | undefined {
  const n = typeof val === "string" ? Number(val) : val;
  return Number.isFinite(n) ? n : undefined;
}

function getString(val: any): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function normalizeMsg(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Conservative transient error classifier to avoid retrying permanent failures.
 * Covers:
 * - common Node network codes
 * - HTTP 429 / 5xx
 * - common Binance transient rate-limit / timestamp drift errors
 */
export function isTransientError(err: unknown): boolean {
  const anyErr = err as any;
  const msg = normalizeMsg(err).toLowerCase();

  const code = getString(anyErr?.code)?.toUpperCase();
  const errno = getString(anyErr?.errno)?.toUpperCase();
  const name = getString(anyErr?.name)?.toLowerCase();

  const networkCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EADDRINUSE",
  ]);
  if ((code && networkCodes.has(code)) || (errno && networkCodes.has(errno))) return true;
  if (name?.includes("timeout")) return true;
  if (msg.includes("timeout")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("network error")) return true;

  const status =
    getNumber(anyErr?.status) ??
    getNumber(anyErr?.statusCode) ??
    getNumber(anyErr?.response?.status) ??
    getNumber(anyErr?.response?.statusCode);

  if (status === 429) return true;
  if (typeof status === "number" && status >= 500 && status <= 599) return true;

  // Binance (various client shapes): error.code, body.code, response.data.code, etc.
  const bCode =
    getNumber(anyErr?.code) ??
    getNumber(anyErr?.body?.code) ??
    getNumber(anyErr?.response?.data?.code) ??
    getNumber(anyErr?.data?.code);

  // Common Binance transient codes:
  // -1003: too many requests / IP rate limit
  // -1021: timestamp for this request is outside of the recvWindow
  // -1099/-1100 style: not always transient; keep conservative (only include obvious ones)
  if (bCode === -1003 || bCode === -1021) return true;

  // Common transient phrases from Binance/infra
  if (msg.includes("too many requests")) return true;
  if (msg.includes("rate limit")) return true;
  if (msg.includes("server is busy")) return true;
  if (msg.includes("service unavailable")) return true;
  if (msg.includes("timestamp for this request is outside")) return true;
  if (msg.includes("recvwindow")) return true;

  return false;
}

function computeDelayMs(baseDelayMs: number, attemptIndex: number, backoffFactor: number, maxDelayMs: number, jitterRatio: number): number {
  // attemptIndex: 0 for the first retry sleep, 1 for the second, ...
  const raw = baseDelayMs * Math.pow(backoffFactor, attemptIndex);
  const capped = Math.min(maxDelayMs, Math.max(baseDelayMs, raw));

  if (jitterRatio <= 0) return Math.floor(capped);

  const jitter = capped * jitterRatio;
  const min = capped - jitter;
  const max = capped + jitter;
  const sampled = min + Math.random() * (max - min);
  return Math.floor(Math.max(0, sampled));
}

export async function withRetries<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = Number.isFinite(options.retries) ? Math.max(0, options.retries!) : 5;
  const minDelayMs = Number.isFinite(options.minDelayMs) ? Math.max(5000, options.minDelayMs!) : 5000;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) ? Math.max(minDelayMs, options.maxDelayMs!) : 60_000;
  const backoffFactor = Number.isFinite(options.backoffFactor) ? Math.max(1, options.backoffFactor!) : 1.5;
  const jitterRatio = Number.isFinite(options.jitterRatio) ? Math.max(0, options.jitterRatio!) : 0.2;
  const label = options.label;
  const classifier = options.isTransientError ?? isTransientError;

  let attempt = 0;
  // Total attempts = 1 + retries
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const remainingRetries = retries - (attempt - 1);
      const isTransient = classifier(err);

      if (!isTransient || remainingRetries <= 0) {
        throw err;
      }

      const delayMs = computeDelayMs(minDelayMs, attempt - 1, backoffFactor, maxDelayMs, jitterRatio);
      options.onRetry?.({
        attempt,
        remainingRetries,
        delayMs,
        error: err,
        label,
      });

      await sleep(delayMs);
    }
  }
}


