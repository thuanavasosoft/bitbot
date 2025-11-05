import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide, IPosition } from "@/services/exchange-service/exchange-type";
import TelegramService from "@/services/telegram.service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import { ISignalData } from "../bb-trend-watcher";
import BreakoutBot, { BBState } from "../breakout-bot";
import BigNumber from "bignumber.js";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";

const WAIT_INTERVAL_MS = 5000;

class BBWaitForEntryState implements BBState {
  private signalListenerRemover?: () => void;

  constructor(private bot: BreakoutBot) { }

  async onEnter() {
    TelegramService.queueMsg(`🔜 Waiting for entry signal (Up/Down)...`);
    console.log("Hooking signal listener for entry...");
    this.signalListenerRemover = this.bot.bbTrendWatcher.hookSignalListener(this._handleSignal.bind(this))
    console.log("Signal listener for entry hooked");
  }

  private async _handleSignal(signalData: ISignalData) {
    const signal = signalData.signalResult.signal;

    // Only enter on Up or Down signals
    if (signal === "Kangaroo") {
      console.log("Kangaroo signal - skipping entry");
      return;
    }

    // Determine position side based on signal
    const posDir: TPositionSide = signal === "Up" ? "long" : "short";
    
    // Only enter if we don't already have a position, or if we have opposite position
    if (this.bot.currActivePosition) {
      if (this.bot.currActivePosition.side === posDir) {
        console.log(`Already have ${posDir} position, skipping entry`);
        return;
      } else {
        // Close opposite position first
        TelegramService.queueMsg(`Signal changed from ${this.bot.currActivePosition.side} to ${posDir}, closing current position...`);
        this.signalListenerRemover && this.signalListenerRemover();
        await this._closeCurrentPosition();
        // Wait a bit for position to be fully closed
        await new Promise(r => setTimeout(r, 2000));
        // Now enter new position
        await this._openPosition(posDir);
        eventBus.emit(EEventBusEventType.StateChange);
        return;
      }
    }

    this.signalListenerRemover && this.signalListenerRemover();
    await this._openPosition(posDir);
    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _closeCurrentPosition() {
    const currLatestMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();

    for (let i = 0; i < 10; i++) {
      try {
        this.bot.bbWsSignaling.broadcast("close-position");
        await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        const position = await ExchangeService.getPosition(this.bot.symbol);
        if (!position) {
          console.log(`[Position Check] Position closed on attempt ${i + 1}`);
          // Get closed position from history to update PnL
          if (this.bot.currActivePosition) {
            const posHistory = await ExchangeService.getPositionsHistory({ positionId: this.bot.currActivePosition.id });
            const closedPos = posHistory[0];
            if (closedPos) {
              const slippage = new BigNumber(currLatestMarkPrice).minus(closedPos.avgPrice).toNumber();
              const timeDiffMs = +new Date(closedPos.updateTime) - triggerTs;
              const icon = this.bot.currActivePosition.side === "long" ? slippage >= 0 ? "🟩" : "🟥" : slippage <= 0 ? "🟩" : "🟥";
              if (icon === "🟥") {
                this.bot.slippageAccumulation += Math.abs(slippage);
              } else {
                this.bot.slippageAccumulation -= Math.abs(slippage);
              }
              this.bot.numberOfTrades++;
              await this.bot.bbUtil.handlePnL(closedPos.realizedPnl, false, icon, slippage, timeDiffMs);
            }
          }
          this.bot.currActivePosition = undefined;
          break;
        }
      } catch (error) {
        console.error(`[Position Check] Error on attempt ${i + 1}: `, error);
        if (i < 9) {
          await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        }
      }
    }
  }

  private async _openPosition(posDir: TPositionSide) {
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
        this.bot.bbWsSignaling.broadcast(`open-${posDir}`, budget);
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
    console.log("Exiting BB Wait For Entry State");
  }
}

export default BBWaitForEntryState;

