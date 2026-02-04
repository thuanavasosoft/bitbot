import TelegramService from "@/services/telegram.service";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { TOrderSide } from "@/services/exchange-service/exchange-type";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { getPositionDetailMsg } from "@/utils/strings.util";

class TMOBWaitForSignalState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async onEnter() {
    TelegramService.queueMsg(`🔜 Waiting for entry signal - monitoring price for support or resistance...`);

    ExchangeService.hookPriceListener(this.bot.symbol, this._handlePriceUpdate.bind(this));
  }



  private async _handlePriceUpdate(price: number) {
    if (!this.bot.longTrigger || !this.bot.shortTrigger) return;
    if (price < this.bot.longTrigger && price > this.bot.shortTrigger) return;

    if (this.bot.isOpeningPosition) return;
    this.bot.isOpeningPosition = true;

    const orderSide: TOrderSide = price <= this.bot.longTrigger ? "sell" : "buy";
    TelegramService.queueMsg(`❤️‍🔥 ${orderSide === "sell" ? "Curr price lower than support" : "Curr price higher than resistance"} opening ${orderSide === "sell" ? "short" : "long"} position...`);

    const clientOrderId = await ExchangeService.generateClientOrderId();
    ExchangeService.hookOrderListener(async (order) => {
      if (order.clientOrderId === clientOrderId && order.orderStatus === "filled") {
        TelegramService.queueMsg(`${orderSide} - ${clientOrderId} order filled, checking position...`);
        let currActivePosition = await ExchangeService.getPosition(this.bot.symbol);
        let i = 0;
        while (!currActivePosition) {
          TelegramService.queueMsg(`Position not found, waiting for 5 seconds before checking again...`);
          await new Promise(r => setTimeout(r, 5000));
          currActivePosition = await ExchangeService.getPosition(this.bot.symbol);

          if (i > 12) {
            TelegramService.queueMsg(`Position not found after 60 seconds, giving up...`);
            break;
          }
          i++;
        }
        this.bot.currActivePosition = currActivePosition;
        const posMsg = getPositionDetailMsg(this.bot.currActivePosition!);
        TelegramService.queueMsg(`🥂️️️️️️ Position found: 
${posMsg}`);

        eventBus.emit(EEventBusEventType.StateChange);
      }
    });

    TelegramService.queueMsg(`Placing ${orderSide} - ${clientOrderId} order...`);
    const orderResp = { orderId: "1234567890" };
    // const orderResp = await ExchangeService.placeOrder({
    //   symbol: this.bot.symbol,
    //   clientOrderId,
    //   orderType: "market",
    //   orderSide,
    //   quoteAmt: this.bot.margin,
    // });
    // console.log("orderResp: ", orderResp);

    TelegramService.queueMsg(`${orderSide} - ${clientOrderId} order placed: (${orderResp.orderId}) waiting for fill...`);
  }

  async onExit() {
    console.log("Exiting TMOBWaitForSignalState");
  }
}

export default TMOBWaitForSignalState;