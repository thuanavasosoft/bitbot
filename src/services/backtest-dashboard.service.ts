/**
 * HTTP client for the backtest-dashboard backend (trail-multiplier optimization runs).
 * Auth: POST /auth/login, then send the auth cookie on subsequent requests.
 */

const AUTH_COOKIE_NAME = "backtest_auth";

export type TrailMultiplierOptimizationRunCreateBody = {
  symbol: string;
  startTime: string;
  endTime: string;
  updateIntervalMinutes: number;
  optimizationWindowMinutes: number;
  trailingAtrLength: number;
  trailMultiplierMin: number;
  trailMultiplierMax: number;
  stepSize: number;
  margin: number;
  leverage: number;
  signalParams: { N: number };
  triggerBufferPercentage: number;
  startingBalance?: number;
  marginPercentOfBalance?: number;
  marginPercentBasis?: "natural" | "virtual_independent";
  stopLossPercentage?: number;
  takeProfitPercentage?: number;
  badEntryLongROCHighThreshold?: number;
  badEntryShortROCLowThreshold?: number;
  badEntryMinUnrealizedPnlPercent?: number;
  trailTightenCutPercent?: number;
  trailTightenCutMode?: "multiplier" | "extreme";
  trailTightenMinMfePercent?: number;
  trailTightenMinStallMinutes?: number;
  trailTightenMaxRocClose?: number;
  tag?: string | null;
};

export type TrailMultiplierOptimizationRunCreated = {
  id: string;
  status: string;
  symbol: string;
};

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
}

function getBaseUrl(): string {
  return requireEnv("BACKTEST_DASHBOARD_URL").replace(/\/+$/, "");
}

function extractAuthCookie(res: Response): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (() => {
          const single = res.headers.get("set-cookie");
          return single ? [single] : [];
        })();

  for (const raw of setCookies) {
    const first = raw.split(";")[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    if (name === AUTH_COOKIE_NAME) return first;
  }
  return undefined;
}

async function parseJsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorMessageFromBody(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && "message" in json) {
    const message = (json as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

class BacktestDashboardService {
  private static authCookie: string | undefined;
  private static authCookieFetchedAtMs = 0;
  private static readonly AUTH_COOKIE_TTL_MS = 6 * 60 * 60 * 1000;

  private static async login(): Promise<string> {
    const baseUrl = getBaseUrl();
    const username = requireEnv("BACKTEST_DASHBOARD_USERNAME");
    const password = requireEnv("BACKTEST_DASHBOARD_PASSWORD");

    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const json = await parseJsonOrNull(res);
    if (!res.ok) {
      throw new Error(
        errorMessageFromBody(json, `Dashboard login failed (${res.status})`)
      );
    }
    const cookie = extractAuthCookie(res);
    if (!cookie) {
      throw new Error("Dashboard login succeeded but auth cookie was missing");
    }
    this.authCookie = cookie;
    this.authCookieFetchedAtMs = Date.now();
    return cookie;
  }

  private static async getAuthCookie(forceRefresh = false): Promise<string> {
    const freshEnough =
      this.authCookie != null &&
      Date.now() - this.authCookieFetchedAtMs < this.AUTH_COOKIE_TTL_MS;
    if (!forceRefresh && freshEnough && this.authCookie) {
      return this.authCookie;
    }
    return this.login();
  }

  static async createTrailMultiplierOptimizationRun(
    body: TrailMultiplierOptimizationRunCreateBody
  ): Promise<TrailMultiplierOptimizationRunCreated> {
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/trail-multiplier-optimization-runs`;

    const post = async (cookie: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      });

    let cookie = await this.getAuthCookie();
    let res = await post(cookie);
    if (res.status === 401) {
      cookie = await this.getAuthCookie(true);
      res = await post(cookie);
    }

    const json = await parseJsonOrNull(res);
    if (!res.ok) {
      throw new Error(
        errorMessageFromBody(json, `Create trail-mult run failed (${res.status})`)
      );
    }
    if (!json || typeof json !== "object" || !("id" in json)) {
      throw new Error("Create trail-mult run returned an unexpected response");
    }
    const payload = json as TrailMultiplierOptimizationRunCreated;
    return {
      id: String(payload.id),
      status: String(payload.status ?? "running"),
      symbol: String(payload.symbol ?? body.symbol),
    };
  }
}

export default BacktestDashboardService;
