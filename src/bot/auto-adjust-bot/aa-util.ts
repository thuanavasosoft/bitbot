import BigNumber from "bignumber.js";
import TelegramService from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import AutoAdjustBot from "./auto-adjust-bot";
import { formatFeeAwarePnLLine } from "@/utils/strings.util";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";

class AAUtil {
  constructor(private bot: AutoAdjustBot) {}

  private async updateBalance() {
    const thisRunCurrQuoteBalance = this.bot.currQuoteBalance;
    const currExchFreeUsdtBalance = await this.getExchFreeUsdtBalance();
    this.bot.currQuoteBalance = currExchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
    return { thisRunCurrQuoteBalance, currExchFreeUsdtBalance };
  }

  private async _getOrderFees(symbol: string, clientOrderId?: string): Promise<BigNumber | null> {
    if (!clientOrderId) return null;
    const trades = await withRetries(
      () => ExchangeService.getTradeList(symbol, clientOrderId),
      {
        label: "[AAUtil] getTradeList",
        retries: 3,
        minDelayMs: 2000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    if (!trades?.length) return null;
    return trades.reduce((sum, trade) => sum.plus(trade.fee?.amt ?? 0), new BigNumber(0));
  }

  private async _estimateTradeFees(symbol: string): Promise<BigNumber | null> {
    const [openFees, closeFees] = await Promise.all([
      this._getOrderFees(symbol, this.bot.lastOpenClientOrderId),
      this._getOrderFees(symbol, this.bot.lastCloseClientOrderId),
    ]);
    if (openFees === null && closeFees === null) return null;
    return (openFees ?? new BigNumber(0)).plus(closeFees ?? new BigNumber(0));
  }

  public async handlePnL(
    PnL: number,
    isLiquidated: boolean,
    icon?: string,
    slippage?: number,
    timeDiffMs?: number,
    closedPositionId?: number,
  ) {
    if (isLiquidated) {
      this.bot.liquidationCount += 1;
    }

    const iterationPnL = new BigNumber(PnL);
    const { thisRunCurrQuoteBalance, currExchFreeUsdtBalance } = await this.updateBalance();
    const prevBalance = new BigNumber(thisRunCurrQuoteBalance || 0);
    const balanceDelta = currExchFreeUsdtBalance.minus(prevBalance);
    const tradeFees = await this._estimateTradeFees(this.bot.symbol);

    let feeEstimate = tradeFees;
    let grossPnl = tradeFees ? balanceDelta.plus(tradeFees) : iterationPnL;
    if (!feeEstimate) {
      feeEstimate = iterationPnL.minus(balanceDelta);
      if (iterationPnL.abs().lt(1e-8) && balanceDelta.abs().gt(1e-8)) {
        grossPnl = balanceDelta;
        feeEstimate = new BigNumber(0);
      }
    }

    const normalize = (value: BigNumber) => {
      if (!value.isFinite()) return undefined;
      if (value.abs().lt(1e-8)) return 0;
      return value.decimalPlaces(6, BigNumber.ROUND_HALF_UP).toNumber();
    };

    const roundedGross = normalize(grossPnl);
    const roundedDelta = normalize(balanceDelta);
    const roundedFees = normalize(feeEstimate);

    this.bot.updateLastTradeMetrics({
      closedPositionId,
      grossPnl: roundedGross,
      balanceDelta: roundedDelta,
      feeEstimate: roundedFees,
      netPnl: roundedDelta,
    });

    this.bot.totalActualCalculatedProfit = new BigNumber(this.bot.totalActualCalculatedProfit)
      .plus(balanceDelta)
      .toNumber();

    const feeAwareLine = formatFeeAwarePnLLine({
      grossPnl: roundedGross,
      feeEstimate: roundedFees,
      netPnl: roundedDelta,
    });

    const msg = `
🏁 PnL Information
Total calculated PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)}

This run quote balance: ${thisRunCurrQuoteBalance} USDT
Next run quote balance: ${currExchFreeUsdtBalance.toFixed(4)} USDT
Wallet delta this resolve: ${balanceDelta.gt(0) ? "🟩" : "🟥"} ${balanceDelta.toFixed(4)} USDT
--
${closedPositionId ? `Closed position id: ${closedPositionId}\n` : ""}${feeAwareLine}
--
${!!icon && !!slippage && !!timeDiffMs ? `-- Close Slippage: --
Time Diff: ${timeDiffMs}ms
Price Diff (pips): ${icon} ${slippage}` : ""}`;

    console.log(msg);
    TelegramService.queueMsg(msg);
  }

  public async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(
      () => ExchangeService.getBalances(),
      {
        label: "[AAUtil] getBalances",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    const usdtBalanceFromExchange = balances.find((item) => item.coin === "USDT");
    return new BigNumber(usdtBalanceFromExchange?.free || 0);
  }
}

export default AAUtil;
