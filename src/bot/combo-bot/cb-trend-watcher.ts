import { TAiCandleTrendDirection } from "@/services/grok-ai.service";
import ComboBot from "./combo-bot";
import TelegramService from "@/services/telegram.service";

export interface ICandlesData {
  candlesImage: any,
  candlesTrend: TAiCandleTrendDirection,
  closePrice: number,
}

interface IAITrendUpdateMsgData {
  identifier: string;
  candlesTrend: TAiCandleTrendDirection;
  closePrice: number;
  candlesImage: string;
  rollWindowInHours: number;
  symbol: string;
}

interface IAITrendUpdateMsg {
  type: "ai-trend-update"
  data: IAITrendUpdateMsgData;
}

type ITMWsMsg = IAITrendUpdateMsg

class CBTrendWatcher {
  private currBigCandlesData!: ICandlesData;
  private currBigCandlesVer: number = 0;
  private currSmallCandlesData!: ICandlesData;
  private currSmallCandlesVer: number = 0;
  private _candlesTrendListener?: (bigCandlesData: ICandlesData, smallCandlesData: ICandlesData) => void;
  isTrendWatcherStarted: boolean = false;

  constructor(private bot: ComboBot) { }

  hookCandlesTrendListener(cb: (bigCandlesData: ICandlesData, smallCandlesData: ICandlesData) => void) {
    this._candlesTrendListener = cb;

    return () => this._candlesTrendListener = undefined;
  }

  private _checkCandlesCombo() {
    TelegramService.queueMsg(`ℹ️ Bet rules for ${this.currBigCandlesData.candlesTrend}-${this.currSmallCandlesData.candlesTrend}: ${this.bot.betRules[this.currBigCandlesData.candlesTrend][this.currSmallCandlesData.candlesTrend].toLocaleUpperCase()}`);
    this._candlesTrendListener && this._candlesTrendListener(this.currBigCandlesData, this.currSmallCandlesData);

  }

  async startWatchCandlesTrend() {
    if (this.isTrendWatcherStarted) return;
    this.isTrendWatcherStarted = true;

    let checkAttempt = -1;
    const isSameBigSmallRollWindow = this.bot.bigCandlesRollWindowInHours === this.bot.smallCandlesRollWindowInHours;

    this.bot.cbWsClient.client.addEventListener("message", async (rawMsg) => {
      const msg = JSON.parse(rawMsg.data) as ITMWsMsg;

      if (msg.type === "ai-trend-update") {
        const data = msg.data;
        const dataFor = this.bot.cbUtil.determineCandlesListenerIdentifierFor(data.identifier);

        if (dataFor === "big") {
          this.currBigCandlesData = data;
          this.currBigCandlesVer++;

          TelegramService.queueMsg(Buffer.from(data.candlesImage, 'base64'));
          TelegramService.queueMsg(`ℹ️ New ${isSameBigSmallRollWindow ? "Big and Small" : "Big"} ${this.bot.bigCandlesRollWindowInHours}H trend check for result: ${data.candlesTrend} - price: ${data.closePrice}`);

          if (isSameBigSmallRollWindow) {
            this.currSmallCandlesData = data;
            this._checkCandlesCombo();
          }
        }

        if (dataFor === "small") {
          const now = new Date();

          const minute = now.getMinutes();
          const bigMod = minute % this.bot.bigAiTrendIntervalCheckInMinutes;

          const divisible = Math.floor(this.bot.bigAiTrendIntervalCheckInMinutes / this.bot.smallAiTrendIntervalCheckInMinutes);
          checkAttempt = (checkAttempt + 1) % (divisible);

          if (!isSameBigSmallRollWindow || (isSameBigSmallRollWindow && checkAttempt !== 0 && bigMod !== 0)) {
            this.currSmallCandlesData = data;
            this.currSmallCandlesVer = (this.currSmallCandlesVer + 1) % divisible

            if (this.currSmallCandlesVer % divisible === 0) this.currBigCandlesVer = 0;
            if (this.currSmallCandlesVer === 1) while (this.currBigCandlesVer < 1) await new Promise(r => setTimeout(r, 100))

            TelegramService.queueMsg(Buffer.from(data.candlesImage, 'base64'));
            TelegramService.queueMsg(`ℹ️ New Small ${data.rollWindowInHours}H trend check for result: ${data.candlesTrend} - price: ${data.closePrice}`);

            this._checkCandlesCombo()
          } else if (isSameBigSmallRollWindow && bigMod === 0) {
            this.currSmallCandlesVer = 0;
            this.currBigCandlesVer = 0;
            checkAttempt = 0;
          }
        }
      }
    });

    this.subscribeToTrendManager(this.bot.cbUtil.getCandlesListenerIdentifier("big"), this.bot.symbol, this.bot.bigCandlesRollWindowInHours, this.bot.bigAiTrendIntervalCheckInMinutes);
    this.subscribeToTrendManager(this.bot.cbUtil.getCandlesListenerIdentifier("small"), this.bot.symbol, this.bot.smallCandlesRollWindowInHours, this.bot.smallAiTrendIntervalCheckInMinutes);
  }

  private subscribeToTrendManager(identifier: string, symbol: string, candlesRollWindowInHours: number, trendCheckIntervalInMinutes: number) {
    this.bot.cbWsClient.sendMsg(JSON.stringify({
      "type": "add-subscriber",
      "data": {
        "identifier": identifier,
        "symbol": symbol,
        "rollWindowInHours": candlesRollWindowInHours,
        "checkIntervalInMinutes": trendCheckIntervalInMinutes,
      }
    }), true);
  }
}

export default CBTrendWatcher;