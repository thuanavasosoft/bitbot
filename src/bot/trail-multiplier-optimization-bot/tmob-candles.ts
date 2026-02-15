import { RingBuffer } from "@/utils/ring-buffer.util";
import TrailMultiplierOptimizationBot from "./trail-multiplier-optimization-bot";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "../breakout-bot/bb-retry";
import { toIso } from "../auto-adjust-bot/candle-utils";

/**
 * Async mutex to serialize access to the shared candle buffer and prevent races
 * when ensurePopulated is called concurrently from TMOBUtils and TMOBCandleWatcher.
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Central candle store for TMOB. Holds exactly optimizationWindowMinutes + nSignal + 1
 * candles in a ring buffer. Used by both TMOBUtils (optimization) and TMOBCandleWatcher (signals).
 * Access is serialized via a mutex to prevent race conditions on concurrent ensurePopulated calls.
 */
class TMOBCandles {
  private savedCandles: RingBuffer<ICandleInfo> | null = null;
  private mutex = new AsyncMutex();

  constructor(private bot: TrailMultiplierOptimizationBot) { }

  /** Buffer holds optimizationWindow + nSignal + 1 candles. */
  private get capacity(): number {
    return this.bot.optimizationWindowMinutes + this.bot.nSignal + 1;
  }

  /**
   * Ensures the candle buffer is populated with candles up to the current minute or 1 minute before now.
   * Fetches from exchange if empty or if the latest candle is older than that.
   */
  async ensurePopulated(): Promise<void> {
    await this.mutex.acquire();
    try {
      const now = Date.now();
      const intervalMs = 60 * 1000;
      const currentMinuteMs = Math.floor(now / intervalMs) * intervalMs;
      const oneMinuteBeforeMs = currentMinuteMs - intervalMs;

      const isRefresh = this.savedCandles !== null;
      let lastOpenTime: number | undefined;

      if (isRefresh) {
        const all = this.savedCandles!.toArray();
        const lastCandle = all[all.length - 1];
        lastOpenTime = lastCandle?.openTime ?? 0;
        const isLatestCurrentOrOneMinuteBefore =
          lastOpenTime === currentMinuteMs || lastOpenTime === oneMinuteBeforeMs;
        if (isLatestCurrentOrOneMinuteBefore) return;
      }

      const endDate = new Date();
      endDate.setSeconds(0);
      endDate.setMilliseconds(0);
      const startDate = isRefresh
        ? new Date(lastOpenTime!)
        : new Date(endDate.getTime() - (this.capacity + 3) * 60 * 1000); // Fetch 3 minutes ago more to avoid missing candles

      const rawCandles = await withRetries(
        () =>
          ExchangeService.getCandles(
            this.bot.symbol,
            startDate,
            endDate,
            "1Min"
          ),
        {
          label: "[TMOBCandles] getCandles (initial)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(
              `${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`,
              error
            );
          },
        }
      );

      const candles = rawCandles.filter(
        (c): c is ICandleInfo => c != null && c.openTime != null
      );
      console.log("candles.length:", candles.length);
      console.log("candles[0].openTime:", toIso(candles[0].openTime));
      console.log("candles[last].openTime:", toIso(candles[candles.length - 1].openTime));

      if (isRefresh) {
        const existingLastOpenTime = lastOpenTime!;
        const toPush = candles.filter((c) => c.openTime > existingLastOpenTime);
        for (const c of toPush) {
          this.savedCandles!.push(c);
        }
      } else {
        if (candles.length < this.capacity) {
          throw new Error(
            `[TMOBCandles] Need at least ${this.capacity} candles for initial population, got ${candles.length}`
          );
        }
        this.savedCandles = RingBuffer.withCapacity(this.capacity, candles);
      }
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Pushes a new candle into the buffer. Overwrites the oldest.
   */
  pushCandle(candle: ICandleInfo): void {
    if (!this.savedCandles) {
      throw new Error(
        "[TMOBCandles] Cannot push before buffer is populated. Call ensurePopulated() first."
      );
    }
    this.savedCandles.push(candle);
  }

  /**
   * Returns candles in the given date range from the buffer.
   */
  async getCandles(startDate: Date, endDate: Date): Promise<ICandleInfo[]> {
    await this.mutex.acquire();
    try {
      if (!this.savedCandles) {
        throw new Error(
          "[TMOBCandles] Buffer not populated. Call ensurePopulated() first."
        );
      }
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();
      const all = this.savedCandles.toArray();
      return all.filter(
        (c) => c.openTime >= startMs && c.openTime < endMs
      );
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Returns all candles in the buffer (for signal calculation).
   */
  async toArray(): Promise<ICandleInfo[]> {
    await this.mutex.acquire();
    try {
      if (!this.savedCandles) {
        throw new Error(
          "[TMOBCandles] Buffer not populated. Call ensurePopulated() first."
        );
      }
      return this.savedCandles.toArray();
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Returns true if the buffer has been populated.
   */
  isPopulated(): boolean {
    return this.savedCandles !== null;
  }
}

export default TMOBCandles;
