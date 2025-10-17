import moment from "moment";
import BigNumber from "bignumber.js";
import type { TDayName } from "@/utils/types.util";
import BudgetingBot from "./budgeting-bot";
import TelegramService from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";

export const sundayDayName: TDayName = "Sunday"

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
    const mexcBalance = await ExchangeService.getBalances()
    const usdtBalanceFromExchange = mexcBalance.find((item) => item.coin === 'USDT')
    console.log('usdtBalanceFromExchange: ', usdtBalanceFromExchange)

    const exchFreeUsdtBalance = new BigNumber(usdtBalanceFromExchange?.free!)
    console.log('exchFreeBalance: ', exchFreeUsdtBalance)

    return exchFreeUsdtBalance
  }

  public async handlePnL(PnL: number) {
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
`;

    this.bot.totalActualCalculatedProfit = new BigNumber(this.bot.totalActualCalculatedProfit).plus(iterationPnL).toNumber();
    console.log(msg);
    TelegramService.queueMsg(msg);
  }
}

export default BBUtil;