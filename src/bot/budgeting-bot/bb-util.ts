import moment from "moment";
import BigNumber from "bignumber.js";
import type { TDayName } from "@/utils/types.util";
import BudgetingBot from "./budgeting-bot";
import TelegramService from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { IPosition } from "@/services/exchange-service/exchange-type";
import DatabaseService from "@/services/database.service";
import { bitBotCommit } from "db/drizzle/schema";

export const sundayDayName: string = "NON-EXISTENT-DAY" // TODO: Change this back if we want this feature properly again

class BBUtil {
  constructor(private bot: BudgetingBot) { }

  public getTodayDayName(): TDayName {
    const now = new Date();
    const startGmtOffset = this.bot.sundayStartGMTTimezone;
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const startDate = new Date(utc + (startGmtOffset * 3600000));
    const startDayName = moment(startDate).format('dddd') as TDayName;

    if (startDayName === sundayDayName) {
      const endGmtOffset = this.bot.sundayEndGMTTimezone;
      const endDate = new Date(utc + (endGmtOffset * 3600000));

      const endDayName = moment(endDate).format('dddd') as TDayName;
      return endDayName;
    }

    return startDayName
  }

  public getMsUntilTomorrow(): number {
    const now = new Date();

    // Calculate the current time in the sundayEndGMTTimezone
    const nowInEndGmt = new Date(now.getTime() + this.bot.sundayEndGMTTimezone * 3600000);

    // Calculate tomorrow at 00:00:00 in the sundayEndGMTTimezone
    const tomorrowInEndGmt = new Date(nowInEndGmt);
    tomorrowInEndGmt.setDate(nowInEndGmt.getDate() + 1);
    tomorrowInEndGmt.setHours(0, 0, 0, 0);

    // The difference in ms between now (in endGmt) and tomorrow 00:00:00 (in endGmt)
    const msToTomorrow = tomorrowInEndGmt.getTime() - nowInEndGmt.getTime();

    return msToTomorrow;
  }

  public async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const balances = await ExchangeService.getBalances()
    const usdtBalanceFromExchange = balances.find((item) => item.coin === 'USDT')
    console.log('usdtBalanceFromExchange: ', usdtBalanceFromExchange)

    const exchFreeUsdtBalance = new BigNumber(usdtBalanceFromExchange?.free!)
    console.log('exchFreeBalance: ', exchFreeUsdtBalance)

    return exchFreeUsdtBalance
  }

  public async handlePnL(PnL: number, icon?: string, slippage?: number, timeDiffMs?: number) {
    console.log("Calculating expected profit...");

    const iterationPnL = new BigNumber(PnL);
    const isProfit = new BigNumber(iterationPnL).gt(0)
    console.log("this iteration Profit: ", iterationPnL);

    const thisRunCurrQuoteBalance = this.bot.currQuoteBalance;
    const currExchFreeUsdtBalance = await this.bot.bbUtil.getExchFreeUsdtBalance()
    await this.bot.startingState.updateBotCurrentBalances();
    let msg: string = "";

    msg = `
🏁 PnL Information
Actual iteration pnl: ${isProfit ? "🟩" : "🟥"} ${iterationPnL.toFixed(3)} USDT

This run quote balance: ${thisRunCurrQuoteBalance} USDT
Next run quote baalnce: ${currExchFreeUsdtBalance} USDT
${!!icon && !!slippage && !!timeDiffMs ? `-- Close Slippage: --
Time Diff: ${timeDiffMs}ms
Price Diff (pips): ${icon} ${slippage}` : ""}
`;

    this.bot.totalActualCalculatedProfit = new BigNumber(this.bot.totalActualCalculatedProfit).plus(iterationPnL).toNumber();
    console.log(msg);
    TelegramService.queueMsg(msg);
  }

  public getWaitInMs() {
    const now = new Date();

    const nextIntervalCheckMinutes = new Date(now.getTime());
    nextIntervalCheckMinutes.setSeconds(0, 0);

    if (now.getSeconds() > 0 || now.getMilliseconds() > 0) nextIntervalCheckMinutes.setMinutes(now.getMinutes() + this.bot.aiTrendIntervalCheckInMinutes);

    const nextCheckTs = nextIntervalCheckMinutes.getTime()
    const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();

    return { nextCheckTs, waitInMs };
  }

  // DATABASE UTILITY
  private bitbotCommitRows: typeof bitBotCommit.$inferInsert[] = [];
  private commitWorkerRunning = false;

  private async processCommitBatch(batchSize = 10) {
    let failedAttempt = 0;
    while (this.bitbotCommitRows.length) {
      await new Promise(r => setTimeout(r, 2000));
      const batch = this.bitbotCommitRows.splice(0, batchSize);
      try {
        console.log(`[BIT_BOT_DATABASE] Saving commit batch (${batch.length})`);
        const resp = await DatabaseService.db.insert(bitBotCommit).values(batch);
        failedAttempt = 0;
        console.log("[BIT_BOT_DATABASE] Commit batch saved:", resp);
      } catch (err) {
        failedAttempt++;
        // Enqueue it back and wait for 5 minutes before saving it again
        this.bitbotCommitRows.unshift(...batch);
        console.error("[BIT_BOT_DATABASE] Error saving commit batch, will retry after 5 minutes. Error:", err, `failed attempt: ${failedAttempt}`);
        await new Promise(r => setTimeout(r, 5 * 60000)); // 5 minutes
      }
    }
  }

  async startCommitDataSaveWorker() {
    if (this.commitWorkerRunning) return;

    this.commitWorkerRunning = true;
    this.processCommitBatch().finally(() => {
      this.commitWorkerRunning = false;
    });
  }

  saveTradeInfo(
    pos: IPosition,
    entryWsPrice: { price: number, time: Date },
    resolveWsPrice: { price: number, time: Date }
  ) {
    try {
      const bitbotCommitRow: typeof bitBotCommit.$inferInsert = {
        posId: String(pos.id),
        runId: this.bot.runId,
        tradeMode: this.bot.betDirection,
        leverage: pos.leverage,
        entryTime: new Date(pos.createTime) as any,
        margin: pos.initialMargin,
        positionSide: pos.side,
        entryAvgPrice: pos.avgPrice,
        realizedProfit: pos.realizedPnl,
        resolveAvgPrice: pos.closePrice!,
        liquidationPrice: pos.liquidationPrice,
        resolveTime: new Date(pos.updateTime) as any,
        wsPriceAtEntry: entryWsPrice?.price,
        wsTimeAtEntry: entryWsPrice?.time ? new Date(entryWsPrice.time) as any : undefined,
        wsPriceAtResolve: resolveWsPrice?.price,
        wsTimeAtResolve: resolveWsPrice?.time ? new Date(resolveWsPrice.time) as any : undefined,
      };
      this.bitbotCommitRows.push(bitbotCommitRow);

      this.startCommitDataSaveWorker();
    } catch (e) {
      console.error("Error on enqueing bitbotCommitRow");
    }
  }
}

export default BBUtil;