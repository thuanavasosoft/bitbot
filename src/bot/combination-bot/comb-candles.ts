import { RingBuffer } from "@/utils/ring-buffer.util";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "./comb-retry";
import type CombBotInstance from "./comb-bot-instance";

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise<void>((resolve) => { this.queue.push(resolve); });
  }
  release(): void {
    if (this.queue.length > 0) this.queue.shift()!();
    else this.locked = false;
  }
}

class CombCandles {
  private savedCandles: RingBuffer<ICandleInfo> | null = null;
  private mutex = new AsyncMutex();

  constructor(private bot: CombBotInstance) { }

  private get capacity(): number {
    return this.bot.optimizationWindowMinutes + this.bot.nSignal + this.bot.trailConfirmBars + 5;
  }

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
        lastOpenTime = all[all.length - 1]?.openTime ?? 0;
        if (lastOpenTime === currentMinuteMs || lastOpenTime === oneMinuteBeforeMs) return;
      }
      const endDate = new Date();
      endDate.setSeconds(0);
      endDate.setMilliseconds(0);
      const startDate = isRefresh
        ? new Date(lastOpenTime!)
        : new Date(endDate.getTime() - this.capacity * 60 * 1000);

      const rawCandles = await withRetries(
        () => ExchangeService.getCandles(this.bot.symbol, startDate, endDate, "1Min"),
        {
          label: "[COMB] getCandles (initial)",
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
        for (const c of candles.filter((c) => c.openTime > existingLastOpenTime)) {
          this.savedCandles!.push(c);
        }
      } else {
        if (candles.length < this.capacity) {
          throw new Error(`[COMB] Need at least ${this.capacity} candles, got ${candles.length}`);
        }
        this.savedCandles = RingBuffer.withCapacity(this.capacity, candles);
      }
    } finally {
      this.mutex.release();
    }
  }

  pushCandle(candle: ICandleInfo): void {
    if (!this.savedCandles) throw new Error("[COMB] Cannot push before buffer is populated.");
    this.savedCandles.push(candle);
  }

  async getCandles(startDate: Date, endDate: Date): Promise<ICandleInfo[]> {
    await this.mutex.acquire();
    try {
      if (!this.savedCandles) throw new Error("[COMB] Buffer not populated.");
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();
      return this.savedCandles.toArray().filter((c) => c.openTime >= startMs && c.openTime < endMs);
    } finally {
      this.mutex.release();
    }
  }

  async toArray(): Promise<ICandleInfo[]> {
    await this.mutex.acquire();
    try {
      if (!this.savedCandles) throw new Error("[COMB] Buffer not populated.");
      return this.savedCandles.toArray();
    } finally {
      this.mutex.release();
    }
  }

  isPopulated(): boolean {
    return this.savedCandles !== null;
  }
}

export default CombCandles;
