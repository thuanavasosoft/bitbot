import type { IAITrend } from "@/services/grok-ai.service";
import TestFollowMultipleExits, { type TFMEBState } from "../test-follow-multiple-exits-bot";
import TelegramService from "@/services/telegram.service";
import moment from "moment";
import type { IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { BigNumber } from "bignumber.js";
import { calcLiquidationPrice, generateRandomNumberOfLength } from "@/utils/maths.util";

class TFMEBWaitForBetSignalState implements TFMEBState {
  private aiTrendHookRemover?: () => void;
  constructor(private bot: TestFollowMultipleExits) { }

  async onEnter() {
    console.log("Entering wait for bet signal state");
    TelegramService.queueMsg(`🔜 Waiting for bet signal...`)

    const nowMs = +new Date();
    if (!!this.bot.nextTrendCheckTs && nowMs < this.bot.nextTrendCheckTs) {
      console.log(`Waiting for ${this.bot.nextTrendCheckTs - nowMs}ms before hook ai trends`);
      await new Promise(r => setTimeout(r, this.bot.nextTrendCheckTs - nowMs))
    }

    this.aiTrendHookRemover = this.bot.tfmebTrendWatcher.hookAiTrends("betting", this._trendHandler.bind(this));
  }

  private async _trendHandler(aiTrend?: IAITrend) {
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
    const betMode = this.bot.betDirection;
    const followsTrend = betMode === "follow";

    const openPosDir: TPositionSide = (trendIsUp === followsTrend) ? "long" : "short";

    const { nextCheckTs } = this.bot.tfmebUtil.getWaitInMs();
    this.bot.nextTrendCheckTs = nextCheckTs;

    await this._openThenWaitAndGetOpenedPositionDetail(openPosDir);

    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _openThenWaitAndGetOpenedPositionDetail(posDir: TPositionSide) {
    const budget = new BigNumber(this.bot.betSize).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);

    const msg = `✨️️️️️️️ Opening ${posDir} position`;
    TelegramService.queueMsg(msg);
    console.log(msg);

    const latestPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();
    this.bot.entryWsPrice = {
      price: latestPrice,
      time: new Date(triggerTs),
    };

    const posSize = new BigNumber(budget).div(latestPrice);
    let position: IPosition = {
      id: generateRandomNumberOfLength(5),
      symbol: this.bot.symbol,
      side: posDir,
      leverage: this.bot.leverage,
      initialMargin: Number(this.bot.betSize),
      notional: Number(budget),
      avgPrice: latestPrice,
      size: posSize.toNumber(),
      liquidationPrice: Number(calcLiquidationPrice(posDir, latestPrice, this.bot.leverage).toFixed(4)),
      marginMode: "isolated",
      maintenanceMargin: 0,
      createTime: +new Date(),
      updateTime: +new Date(),
      realizedPnl: 0,
      unrealizedPnl: 0,
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
`);
  }

  async onExit() {
    console.log("Exiting wait for bet signal state...");
  }
}

export default TFMEBWaitForBetSignalState;