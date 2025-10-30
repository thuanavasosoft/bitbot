import { TAiCandleTrendDirection } from "@/services/grok-ai.service";
import ComboBot from "./combo-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { generateImageOfCandles } from "@/utils/image-generator.util";
import TelegramService from "@/services/telegram.service";

export interface ICandlesData {
  candlesImageData: any,
  candlesTrend: TAiCandleTrendDirection,
  closePrice: number,
}

class CBTrendWatcher {
  private _currBigCandlesData?: ICandlesData;
  private _candlesTrendListener?: (bigCandlesData: ICandlesData, smallCandlesData: ICandlesData) => void;
  isTrendWatcherStarted: boolean = false;

  constructor(private bot: ComboBot) { }

  hookCandlesTrendListener(cb: (bigCandlesData: ICandlesData, smallCandlesData: ICandlesData) => void) {
    this._candlesTrendListener = cb;

    return () => this._candlesTrendListener = undefined;
  }

  async startWatchCandlesTrend() {
    if (this.isTrendWatcherStarted) return;
    this.isTrendWatcherStarted = true;
    let checkAttempt = -1;

    while (true) {
      if (this.bot.connectedClientsAmt === 0) {
        TelegramService.queueMsg("❗ No clients connected yet, waiting for client to be connected to continue...");

        while (true) {
          if (this.bot.connectedClientsAmt > 0) {
            TelegramService.queueMsg("✅ Client connected, continuing to wait for signal...");
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
        }
      }

      checkAttempt = (checkAttempt + 1) % ((this.bot.bigAiTrendIntervalCheckInMinutes / this.bot.smallAiTrendIntervalCheckInMinutes));

      const isNotNecessaryToCheckBig = !this._currBigCandlesData || checkAttempt === 0;
      const isNotNecessaryToCheckSmall = (this.bot.bigCandlesRollWindowInHours === this.bot.smallCandlesRollWindowInHours && checkAttempt === 0);

      const candlesEndDate = new Date();
      let [bigCandlesData, smallCandlesData] = await Promise.all([
        isNotNecessaryToCheckBig ? this._getCandlesData(candlesEndDate, this.bot.bigCandlesRollWindowInHours) : Promise.resolve(this._currBigCandlesData!),
        isNotNecessaryToCheckSmall ? Promise.resolve(undefined as any as ICandlesData) : this._getCandlesData(candlesEndDate, this.bot.smallCandlesRollWindowInHours)
      ]);

      if (isNotNecessaryToCheckSmall) smallCandlesData = bigCandlesData
      this._currBigCandlesData = bigCandlesData;

      if (checkAttempt === 0) {
        TelegramService.queueMsg(bigCandlesData.candlesImageData);
        TelegramService.queueMsg(`ℹ️ New ${isNotNecessaryToCheckSmall ? "Big and Small" : "Big"} ${this.bot.bigCandlesRollWindowInHours}H breakout trend check for result: ${bigCandlesData.candlesTrend} - price: ${bigCandlesData.closePrice}`);
      }

      if (!isNotNecessaryToCheckSmall) {
        TelegramService.queueMsg(smallCandlesData.candlesImageData);
        TelegramService.queueMsg(`ℹ️ New Small ${this.bot.smallCandlesRollWindowInHours}H breakout trend check for result: ${smallCandlesData.candlesTrend} - price: ${smallCandlesData.closePrice}`);
      }

      TelegramService.queueMsg(`ℹ️ Bet rules for ${bigCandlesData.candlesTrend}-${smallCandlesData.candlesTrend}: ${this.bot.betRules[bigCandlesData.candlesTrend][smallCandlesData.candlesTrend].toLocaleUpperCase()}`);
      this._candlesTrendListener && this._candlesTrendListener(bigCandlesData, smallCandlesData);

      await this._waitForNextCheck(this.bot.smallAiTrendIntervalCheckInMinutes);
    }
  }

  private async _waitForNextCheck(delayInMin: number) {
    const now = new Date();

    const nextIntervalCheckMinutes = new Date(now.getTime());
    nextIntervalCheckMinutes.setSeconds(0, 0);

    if (now.getSeconds() > 0 || now.getMilliseconds() > 0) nextIntervalCheckMinutes.setMinutes(now.getMinutes() + delayInMin);
    const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();

    await new Promise(r => setTimeout(r, waitInMs));
  }

  private async _getCandlesData(candlesEndDate: Date, rollWindowInHours: number): Promise<ICandlesData> {
    const candlesStartDate = new Date(candlesEndDate.getTime() - (rollWindowInHours * 60 * 60 * 1000));
    const candles = await ExchangeService.getCandles(this.bot.symbol, candlesStartDate, candlesEndDate, "1Min");
    const candlesImageData = await generateImageOfCandles(this.bot.symbol, candles);
    const candlesTrend = await this.bot.grokAi.analyzeBreakOutTrend(candlesImageData);

    return { candlesImageData, candlesTrend, closePrice: candles[candles.length - 1].closePrice };
  }
}

export default CBTrendWatcher;