import TelegramService from "@/services/telegram.service";
import BreakoutBot from "./breakout-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import BigNumber from "bignumber.js";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";

class BBUtil {
  constructor(private bot: BreakoutBot) { }

  private async updateBalance() {
    const thisRunCurrQuoteBalance = this.bot.currQuoteBalance;
    const currExchFreeUsdtBalance = await this.bot.bbUtil.getExchFreeUsdtBalance()
    await this.bot.startingState.updateBotCurrentBalances();

    return { thisRunCurrQuoteBalance, currExchFreeUsdtBalance };
  }

  public async handlePnL(PnL: number, isLiquidated: boolean, icon?: string, slippage?: number, timeDiffMs?: number) {
    console.log("Calculating expected profit...");

    const iterationPnL = new BigNumber(PnL);
    const isProfit = new BigNumber(iterationPnL).gt(0)
    console.log("this iteration Profit: ", iterationPnL);

    const { thisRunCurrQuoteBalance, currExchFreeUsdtBalance } = await this.updateBalance();

    this.bot.totalActualCalculatedProfit = new BigNumber(this.bot.totalActualCalculatedProfit).plus(iterationPnL).toNumber();

    // Record PnL history
    const currentTimestamp = Date.now();
    this.bot.pnlHistory.push({
      timestamp: currentTimestamp,
      totalPnL: this.bot.totalActualCalculatedProfit,
    });

    // Generate and send graph if we have at least 10 resolves
    if (this.bot.pnlHistory.length >= 10) {
      try {
        const pnlChartImage = await generatePnLProgressionChart(this.bot.pnlHistory);
        TelegramService.queueMsg(pnlChartImage);
        TelegramService.queueMsg(
          `📊 PnL Progression Chart\n` +
          `Total resolves: ${this.bot.pnlHistory.length}\n` +
          `Current PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)} USDT`
        );
      } catch (error) {
        console.error("Error generating PnL chart:", error);
        TelegramService.queueMsg(`⚠️ Failed to generate PnL progression chart: ${error}`);
      }
    }

    const msg = `
🏁 PnL Information
Actual iteration pnl: ${isProfit ? "🟩" : "🟥"} ${iterationPnL.toFixed(4)} USDT
Total calculated PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)}

This run quote balance: ${thisRunCurrQuoteBalance} USDT
Next run quote balance: ${currExchFreeUsdtBalance.toFixed(4)} USDT
${!!icon && !!slippage && !!timeDiffMs ? `-- Close Slippage: --
Time Diff: ${timeDiffMs}ms
Price Diff (pips): ${icon} ${slippage}` : ""}`;

    console.log(msg);
    TelegramService.queueMsg(msg);
  }

  public async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const mexcBalance = await ExchangeService.getBalances()
    const usdtBalanceFromExchange = mexcBalance.find((item) => item.coin === 'USDT')
    console.log('usdtBalanceFromExchange: ', usdtBalanceFromExchange)

    const exchFreeUsdtBalance = new BigNumber(usdtBalanceFromExchange?.free!)
    console.log('exchFreeBalance: ', exchFreeUsdtBalance)

    return exchFreeUsdtBalance
  }
}

export default BBUtil;

