import type { IAITrend, TAiCandleTrendDirection } from "@/services/grok-ai.service";
import BudgetingBot, { type BBState } from "../budgeting-bot";
import TelegramService from "@/services/telegram.service";
import moment from "moment";
import { sundayDayName } from "../bb-util";
import type { IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { BigNumber } from "bignumber.js";

const WAIT_INTERVAL_MS = 5000;

class BBWaitForBetSignalState implements BBState {
  private aiTrendHookRemover?: () => void;
  constructor(private bot: BudgetingBot) { }

  async onEnter() {
    console.log("Entering wait for bet signal state");
    TelegramService.queueMsg(`🔜 Waiting for bet signal...`)

    const nowMs = +new Date();
    if (!!this.bot.nextTrendCheckTs && nowMs < this.bot.nextTrendCheckTs) {
      console.log(`Waiting for ${this.bot.nextTrendCheckTs - nowMs}ms before hook ai trends`);
      await new Promise(r => setTimeout(r, this.bot.nextTrendCheckTs - nowMs))
    }

    this.aiTrendHookRemover = this.bot.bbTrendWatcher.hookAiTrends("betting", this._trendHandler.bind(this));
  }

  private async _trendHandler(aiTrend?: IAITrend) {
    const isTodaySunday = this.bot.bbUtil.getTodayDayName() === sundayDayName;
    if (aiTrend?.trend === "Kangaroo") return;

    console.log("Handle bet signal triggered ai trend: ", aiTrend);
    this.aiTrendHookRemover && this.aiTrendHookRemover();

    TelegramService.queueMsg(`
🥂️️️️️️ Bet signal ai trend triggered: ${aiTrend?.trend}
candles start at: ${moment(aiTrend?.startDate).format("YYYY-MM-DD HH:mm:ss")} 
candles end at: ${moment(aiTrend?.endDate).format("YYYY-MM-DD HH:mm:ss")} 
close price: ${aiTrend?.closePrice}
`);

    const trendIsUp = aiTrend?.trend.includes("Up") ?? false;
    const betMode = isTodaySunday ? this.bot.sundayBetDirection : this.bot.betDirection;
    const followsTrend = betMode === "follow";

    const openPosDir: TPositionSide = (trendIsUp === followsTrend) ? "long" : "short";

    const { nextCheckTs } = this.bot.bbUtil.getWaitInMs();
    this.bot.nextTrendCheckTs = nextCheckTs;

    await this._openThenWaitAndGetOpenedPositionDetail(openPosDir);

    this.bot.commitedBetEntryTrend = aiTrend?.trend as Omit<TAiCandleTrendDirection, "Kangaroo">;
    this.bot.shouldResolvePositionTrends = ["Kangaroo", aiTrend?.trend === "Up" ? "Down" : "Up"]

    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _openThenWaitAndGetOpenedPositionDetail(posDir: TPositionSide) {
    const budget = new BigNumber(this.bot.betSize).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);

    const msg = `✨️️️️️️️ Opening ${posDir} position`;
    TelegramService.queueMsg(msg);
    console.log(msg);
    console.log(`Broadcasting: open-${posDir}`);

    const latestPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();


    this.bot.bbWSSignaling.broadcast(`open-${posDir}`, budget);
    await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));

    let position: IPosition | undefined = undefined;
    for (let i = 0; i < 10; i++) {
      try {
        console.log(`[Position Check] Attempt ${i + 1}: Checking for position on symbol ${this.bot.symbol}...`);
        position = await ExchangeService.getPosition(this.bot.symbol);
        console.log("position: ", position);

        const msg = `[Position Check] Attempt ${i + 1}: Position check result: ${position ? 'Found' : 'Not found. Reopening position...'} `;
        console.log(msg);
        TelegramService.queueMsg(msg);

        if (!!position) {
          console.log(`[Position Check] Position found on attempt ${i + 1}, stop checking`);
          break;
        } else if (i < 9) {
          const budget = new BigNumber(this.bot.betSize).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);
          this.bot.bbWSSignaling.broadcast(`open-${posDir}`, budget);
          console.log(`[Position Check] Position not found on attempt ${i + 1} reopening position and will check again after 15 seconds...`);
          await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        }
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
    const priceDiff = new BigNumber(latestPrice).minus(positionAvgPrice).toNumber();

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
`)
  }

  async onExit() {
    console.log("Exiting wait for bet signal state...");
  }
}

export default BBWaitForBetSignalState;