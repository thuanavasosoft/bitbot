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

    // Record individual trade PnL for mode flipping logic
    this.bot.tradePnLHistory.push({
      timestamp: currentTimestamp,
      pnl: PnL,
    });

    // Generate and send graph if we have at least 2 resolves
    if (this.bot.pnlHistory.length >= 2) {
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

    // Check if mode should be flipped based on last 30 minutes of trades
    this._checkAndFlipModeIfNeeded();
  }

  /**
   * Check if trades since last flip time (at least 30 minutes) are unprofitable
   * If unprofitable, flip the trading mode
   * After flipping, waits at least 30 minutes before checking again
   */
  private _checkAndFlipModeIfNeeded() {
    const now = Date.now();
    const thirtyMinutesAfterFlip = this.bot.lastFlipTime + (30 * 60 * 1000); // 30 minutes after last flip

    // Only check if at least 30 minutes have passed since last flip
    if (now < thirtyMinutesAfterFlip) {
      return; // Too soon to check - need to wait at least 30 minutes
    }

    // Get all trades from last flip time onwards
    const recentTrades = this.bot.tradePnLHistory.filter(
      trade => trade.timestamp >= this.bot.lastFlipTime
    );

    if (recentTrades.length === 0) {
      return; // No trades to evaluate
    }

    // Calculate total PnL for trades since last flip
    const totalPnL = recentTrades.reduce((sum, trade) => sum + trade.pnl, 0);

    // If unprofitable, flip mode
    if (totalPnL < 0) {
      const oldMode = this.bot.tradingMode;
      this.bot.tradingMode = this.bot.tradingMode === "against" ? "follow" : "against";
      this.bot.lastFlipTime = now; // Update flip time to now

      const msg = `🔄 Trading mode flipped due to unprofitable trades: ${oldMode} → ${this.bot.tradingMode}\n` +
        `Trades since last flip: ${recentTrades.length}, Total PnL: ${totalPnL.toFixed(4)} USDT`;
      console.log(msg);
      TelegramService.queueMsg(msg);
    }
  }

  /**
   * Manually flip the trading mode
   */
  public flipTradingMode() {
    const oldMode = this.bot.tradingMode;
    this.bot.tradingMode = this.bot.tradingMode === "against" ? "follow" : "against";
    this.bot.lastFlipTime = Date.now();

    const msg = `🔄 Trading mode manually flipped: ${oldMode} → ${this.bot.tradingMode}`;
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

