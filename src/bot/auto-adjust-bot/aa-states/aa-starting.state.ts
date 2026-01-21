import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import AutoAdjustBot, { AAState } from "../auto-adjust-bot";
import { getCandlesForBacktest } from "../getCandlesForBacktest";
import { computeWarmupBars } from "../warmup";
import { isTransientError, withRetries } from "../../breakout-bot/bb-retry";
import { sliceCandles, toIso } from "../candle-utils";

class AAStartingState implements AAState {
  constructor(private bot: AutoAdjustBot) {}

  async onEnter() {
    const symbol = this.bot.symbol;
    const startMs = this.bot.startMs;
    const endMs = this.bot.endMs;

    const msg = `⚙️ Starting Auto-Adjust Bot\nSymbol: ${symbol}\nStart: ${toIso(startMs)}\nEnd: ${toIso(endMs)}\nUpdate interval: ${this.bot.updateIntervalMinutes}m\nOptimization window: ${this.bot.optimizationWindowMinutes}m`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    this.bot.symbolInfo = await withRetries(
      () => ExchangeService.getSymbolInfo(symbol),
      {
        label: "[AutoAdjustBot] getSymbolInfo",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    this.bot.pricePrecision = this.bot.symbolInfo?.pricePrecision ?? 0;
    this.bot.tickSize = Math.pow(10, -this.bot.pricePrecision);

    const maxWarmupBars = computeWarmupBars(this.bot.signalParams, this.bot.atrBounds.max);
    this.bot.maxWarmupBars = maxWarmupBars;
    this.bot.fetchStartMs = Math.max(0, startMs - maxWarmupBars * 60_000);
    this.bot.fetchEndMs = endMs + 60_000;

    const { candles } = await getCandlesForBacktest({
      symbol,
      interval: "1m",
      fetchStartMs: this.bot.fetchStartMs,
      endMs: this.bot.fetchEndMs,
    });
    if (!candles.length) {
      throw new Error("No candles available for the requested range");
    }

    this.bot.candles = candles;
    this.bot.candleByOpenTime = new Map(candles.map((c) => [c.openTime, c]));
    this.bot.candleCount = sliceCandles(candles, startMs, endMs).length;

    if (this.bot.candleCount === 0) {
      throw new Error("No candles available within requested interval");
    }

    this.bot.initializeRunState();

    TelegramService.queueMsg(
      `📊 Loaded ${candles.length} candles (requested range count=${this.bot.candleCount}).\nWarmup bars: ${maxWarmupBars}\nFetch range: ${toIso(this.bot.fetchStartMs)} → ${toIso(this.bot.fetchEndMs)}`
    );

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting AA Starting State");
  }
}

export default AAStartingState;
