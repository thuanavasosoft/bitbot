import { RingBuffer } from "@/utils/ring-buffer.util";
import type { ICandleInfo, TCandleResolution } from "@/services/exchange-service/exchange-type";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { isTransientError, withRetries } from "./fm-retry";
import type FollowMartingaleBot from "./follow-martingale-bot";

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) this.queue.shift()!();
    else this.locked = false;
  }
}

const RESOLUTION_TO_MS: Record<TCandleResolution, number> = {
  "1Min": 60_000,
  "3Min": 3 * 60_000,
  "5Min": 5 * 60_000,
  "15Min": 15 * 60_000,
  "30Min": 30 * 60_000,
  "60Min": 60 * 60_000,
  "4Hour": 4 * 60 * 60_000,
  "8Hour": 8 * 60 * 60_000,
  "1Day": 24 * 60 * 60_000,
  "1Week": 7 * 24 * 60 * 60_000,
  "1Month": 30 * 24 * 60 * 60_000,
};

class FMCandles {
  private savedCandles: RingBuffer<ICandleInfo> | null = null;
  private mutex = new AsyncMutex();

  constructor(private bot: FollowMartingaleBot) {}

  get intervalMs(): number {
    return RESOLUTION_TO_MS[this.bot.candleResolution];
  }

  private get capacity(): number {
    return Math.max(this.bot.signalN * 2 + this.bot.maxLegs + 10, this.bot.signalN + 20);
  }

  private floorToResolution(ms: number): number {
    return Math.floor(ms / this.intervalMs) * this.intervalMs;
  }

  async ensurePopulated(): Promise<void> {
    await this.mutex.acquire();
    try {
      const now = Date.now();
      const currentBarOpenMs = this.floorToResolution(now);
      const prevBarOpenMs = currentBarOpenMs - this.intervalMs;
      const isRefresh = this.savedCandles !== null;
      let lastOpenTime: number | undefined;

      if (isRefresh) {
        const all = this.savedCandles!.toArray();
        lastOpenTime = all[all.length - 1]?.openTime ?? 0;
        if (lastOpenTime === currentBarOpenMs || lastOpenTime === prevBarOpenMs) return;
      }

      const endDate = new Date(currentBarOpenMs);
      const startDate = isRefresh
        ? new Date(lastOpenTime!)
        : new Date(endDate.getTime() - this.capacity * this.intervalMs);

      const rawCandles = await withRetries(
        () => ExchangeService.getCandles(this.bot.symbol, startDate, endDate, this.bot.candleResolution),
        {
          label: "[FM] getCandles",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );

      const candles = rawCandles.filter((c): c is ICandleInfo => c != null && c.openTime != null);

      if (isRefresh) {
        const existingLastOpenTime = lastOpenTime!;
        for (const candle of candles.filter((c) => c.openTime > existingLastOpenTime)) {
          this.savedCandles!.push(candle);
        }
      } else {
        if (candles.length < Math.min(this.capacity, this.bot.signalN + 2)) {
          throw new Error(`[FM] Need at least ${Math.min(this.capacity, this.bot.signalN + 2)} candles, got ${candles.length}`);
        }
        this.savedCandles = RingBuffer.withCapacity(this.capacity, candles);
      }
    } finally {
      this.mutex.release();
    }
  }

  async toArray(): Promise<ICandleInfo[]> {
    await this.mutex.acquire();
    try {
      if (!this.savedCandles) throw new Error("[FM] Candle buffer not populated");
      return this.savedCandles.toArray();
    } finally {
      this.mutex.release();
    }
  }

  isPopulated(): boolean {
    return this.savedCandles !== null;
  }
}

export default FMCandles;
