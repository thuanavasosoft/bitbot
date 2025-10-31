import TelegramService from "@/services/telegram.service";
import ComboBot from "./combo-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import BigNumber from "bignumber.js";
import { TAiCandleTrendDirection } from "@/services/grok-ai.service";

class CBUtil {
  constructor(private bot: ComboBot) { }

  private async updateBalance() {
    const thisRunCurrQuoteBalance = this.bot.currQuoteBalance;
    const currExchFreeUsdtBalance = await this.bot.cbUtil.getExchFreeUsdtBalance()
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
    const commitedTrendCombo = this.bot.currCommitedTrendCombo!;
    this.bot.trendComboRecords[commitedTrendCombo.big][commitedTrendCombo.small].pnl = new BigNumber(this.bot.trendComboRecords[commitedTrendCombo.big][commitedTrendCombo.small].pnl).plus(PnL).toNumber();
    if (isLiquidated) this.bot.trendComboRecords[commitedTrendCombo.big][commitedTrendCombo.small].liquidatedCount += 1;
    this.bot.currCommitedTrendCombo = undefined;

    const msg = `
🏁 PnL Information
Actual iteration pnl: ${isProfit ? "🟩" : "🟥"} ${iterationPnL.toFixed(4)} USDT
Total calculated PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)}

This run quote balance: ${thisRunCurrQuoteBalance} USDT
Next run quote baalnce: ${currExchFreeUsdtBalance.toFixed(4)} USDT
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

  getBetRulesMsg() {
    const getBetRuleDetail = (bigTrend: TAiCandleTrendDirection, smallTrend: TAiCandleTrendDirection) => {
      const betRule = this.bot.betRules[bigTrend][smallTrend];
      return `${betRule === "long" ? "🟢" : betRule === "short" ? "🔴" : "Skip"} (${this.bot.trendComboRecords[bigTrend][smallTrend].entriesAmt.toLocaleString()}). pnl: ${this.bot.trendComboRecords[bigTrend][smallTrend].pnl >= 0 ? "🟩" : "🟥"} ${this.bot.trendComboRecords[bigTrend][smallTrend].pnl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })} liquidated count: ${this.bot.trendComboRecords[bigTrend][smallTrend].liquidatedCount}`
    };

    const msg = `
- Kangaroo:
    Kangaroo: ${getBetRuleDetail("Kangaroo", "Kangaroo")}
    Up: ${getBetRuleDetail("Kangaroo", "Up")}
    Down: ${getBetRuleDetail("Kangaroo", "Down")}
- Up:
    Kangaroo: ${getBetRuleDetail("Up", "Kangaroo")}
    Up: ${getBetRuleDetail("Up", "Up")}
    Down: ${getBetRuleDetail("Up", "Down")}
- Down:
    Kangaroo: ${getBetRuleDetail("Down", "Kangaroo")}
    Up: ${getBetRuleDetail("Down", "Up")}
    Down: ${getBetRuleDetail("Down", "Down")}`

    return msg;
  }
}

export default CBUtil;