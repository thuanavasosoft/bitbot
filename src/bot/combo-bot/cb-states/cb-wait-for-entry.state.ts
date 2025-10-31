import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide, IPosition } from "@/services/exchange-service/exchange-type";
import TelegramService from "@/services/telegram.service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import { ICandlesData } from "../cb-trend-watcher";
import ComboBot, { CBState } from "../combo-bot";
import BigNumber from "bignumber.js";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";

const WAIT_INTERVAL_MS = 5000;

class CBWaitForEntryState implements CBState {
  private trendListenerRemover?: () => void;

  constructor(private bot: ComboBot) { }

  async onEnter() {

    if (!!this.bot.nextRunForceBetCandlesDatas) {
      TelegramService.queueMsg(`Previous run closed with trend (${this.bot.nextRunForceBetCandlesDatas.big.candlesTrend}-${this.bot.nextRunForceBetCandlesDatas.small.candlesTrend}), opening new ${this.bot.betRules[this.bot.nextRunForceBetCandlesDatas.big.candlesTrend][this.bot.nextRunForceBetCandlesDatas.small.candlesTrend]} position right away`);
      this._handleTrend(this.bot.nextRunForceBetCandlesDatas.big, this.bot.nextRunForceBetCandlesDatas.small);
      this.bot.nextRunForceBetCandlesDatas = undefined;
    } else {
      TelegramService.queueMsg(`🔜 Waiting for entry signal...`);
      console.log("Hooking trend listener for entry...");
      this.trendListenerRemover = this.bot.cbTrendWatcher.hookCandlesTrendListener(this._handleTrend.bind(this))
      console.log("Trend listener for entry hooked");
    }
  }

  private async _handleTrend(bigCandlesData: ICandlesData, smallCandlesData: ICandlesData) {
    const ruleValPosDir = this.bot.betRules[bigCandlesData!.candlesTrend][smallCandlesData!.candlesTrend];

    if (ruleValPosDir === "skip") return;

    this.trendListenerRemover && this.trendListenerRemover()
    await this._openThenWaitAndGetOpenedPositionDetail(ruleValPosDir);

    this.bot.betRuleValsToResolvePosition = ["skip", ruleValPosDir === "long" ? "short" : "long"];
    this.bot.trendComboRecords[bigCandlesData.candlesTrend][smallCandlesData.candlesTrend].entriesAmt = this.bot.trendComboRecords[bigCandlesData.candlesTrend][smallCandlesData.candlesTrend].entriesAmt + 1;
    this.bot.currCommitedTrendCombo = { big: bigCandlesData.candlesTrend, small: smallCandlesData.candlesTrend }
    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _openThenWaitAndGetOpenedPositionDetail(posDir: TPositionSide) {
    const budget = new BigNumber(this.bot.betSize).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);

    const msg = `✨️️️️️️️ Opening ${posDir} position`;
    TelegramService.queueMsg(msg);
    console.log(msg);
    console.log(`Broadcasting: open-${posDir}`);

    const currLatestMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();
    this.bot.entryWsPrice = {
      price: currLatestMarkPrice,
      time: new Date(triggerTs),
    };

    console.log("Opening position...");
    let position: IPosition | undefined = undefined;
    for (let i = 0; i < 10; i++) {
      try {
        this.bot.cbWsSignaling.broadcast(`open-${posDir}`, budget);
        await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        position = await ExchangeService.getPosition(this.bot.symbol);
        console.log("position: ", position);

        if (!!position) {
          console.log(`[Position Check] Position found on attempt ${i + 1}, stop checking`);
          break;
        }

        const msg = `[Position Check] Attempt ${i + 1}: Position check result: ${position ? 'Found' : 'Not found. Reopening position...'} `;
        console.log(msg);
        TelegramService.queueMsg(msg);
      } catch (error) {
        console.error(`[Position Check] Error on attempt ${i + 1}: `, error);
        if (i < 9) {
          console.log(`[Position Check] Waiting 5 seconds before retry...`);
          await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        }
      }
    }

    if (!position) {
      // Debug: Check all open positions to see if the position exists but wasn't found by symbol
      console.log(`[Position Check] Position not found by symbol ${this.bot.symbol}, checking all open positions...`);
      const allPositions = await ExchangeService.getOpenedPositions();
      console.log(`[Position Check] All open positions: `, allPositions);

      const msg = "❌ Position not opened even after 60 seconds after signaling to open please check..."
      TelegramService.queueMsg(msg);
      await new Promise(r => setTimeout(r, 1000));
      throw new Error(msg);
    };

    this.bot.currActivePosition = position;
    this.bot.numberOfTrades++;

    const positionAvgPrice = position.avgPrice;
    const positionTriggerTs = +new Date(position.createTime);
    const timeDiffMs = positionTriggerTs - triggerTs;
    const priceDiff = new BigNumber(currLatestMarkPrice).minus(positionAvgPrice).toNumber();

    const icon = posDir === "long" ? priceDiff <= 0 ? "🟩" : "🟥" :
      priceDiff >= 0 ? "🟩" : "🟥";
    if (icon === "🟥") {
      this.bot.slippageAccumulation += Math.abs(priceDiff);
    } else {
      this.bot.slippageAccumulation -= Math.abs(priceDiff);
    }

    console.log("Opened position: ", position);
    TelegramService.queueMsg(`
🥳️️️️️️ New position opened
${getPositionDetailMsg(position)}
--Open Slippage: --
Time Diff: ${timeDiffMs} ms
Price Diff(pips): ${icon} ${priceDiff}
`);
  }

  async onExit() {
    console.log("Exiting CB Wait For Entry State");
  }
}

export default CBWaitForEntryState;