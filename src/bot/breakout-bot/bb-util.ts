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

    const rollingHistory = this.bot.pnlHistory.slice(-500);

    // Generate and send graph if we have at least 2 resolves
    if (rollingHistory.length >= 2) {
      try {
        const pnlChartImage = await generatePnLProgressionChart(rollingHistory);
        TelegramService.queueMsg(pnlChartImage);
        TelegramService.queueMsg(
          `📊 PnL Progression Chart (last ${rollingHistory.length} resolves, max 500)\n` +
          `Total resolves recorded: ${this.bot.pnlHistory.length}\n` +
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
    const balances = await ExchangeService.getBalances()
    const usdtBalanceFromExchange = balances.find((item) => item.coin === 'USDT')
    console.log('usdtBalanceFromExchange: ', usdtBalanceFromExchange)

    const exchFreeUsdtBalance = new BigNumber(usdtBalanceFromExchange?.free!)
    console.log('exchFreeBalance: ', exchFreeUsdtBalance)

    return exchFreeUsdtBalance
  }
}

export default BBUtil;

