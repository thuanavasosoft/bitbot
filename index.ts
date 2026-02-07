import dotenv from 'dotenv';
import TelegramService from "@/services/telegram.service";
import BudgetingBot from '@/bot/budgeting-bot/budgeting-bot';
import ExchangeService from '@/services/exchange-service/exchange-service';
// import DatabaseService from '@/services/database.service';
import ComboBot from '@/bot/combo-bot/combo-bot';
import BreakoutBot from '@/bot/breakout-bot/breakout-bot';
import AutoAdjustBot from '@/bot/auto-adjust-bot/auto-adjust-bot';
import TrailMultiplierOptimizationBot from '@/bot/trail-multiplier-optimization-bot/trail-multiplier-optimization-bot';

async function runProgram() {
  try {
    dotenv.config();

    await TelegramService.initialize();
    // await DatabaseService.configure();

    const symbols = process.env.SYMBOLS?.split(",") || []
    const symbol = process.env.SYMBOL;

    if (!symbol && !symbols.length) throw "PLEASE SPECIFY EITHER SYMBOL OR SYMBOLS ACCORDING TO THE BOT";
    await ExchangeService.configure(
      process.env.API_KEY!,
      process.env.API_SECRET!,
      !!symbol ? [symbol] : symbols,
    );

    const botMode = process.env.BOT_MODE;
    console.log("BOT MODE: ", botMode);


    if (botMode === "combo_bot") {
      const bot = new ComboBot();
      await bot.startMakeMoney();
    } else if (botMode === "budgeting_bot") {
      const bot = new BudgetingBot();
      await bot.startMakeMoney();
    } else if (botMode === "breakout_bot") {
      const bot = new BreakoutBot();
      await bot.startMakeMoney();
    } else if (botMode === "auto_adjust_bot") {
      const bot = new AutoAdjustBot();
      await bot.startMakeMoney();
    } else if (botMode === "trail_multiplier_optimization_bot") {
      const bot = new TrailMultiplierOptimizationBot();
      await bot.startMakeMoney();
    }

  } catch (error) {
    console.log("Program error: ", error);

    if (error instanceof Error) {
      console.log(`Error: ${error.message}`);
      TelegramService.queueMsg(`Error: ${error.message}`);
    } else {
      TelegramService.queueMsg(`An unknown error occurred. ${typeof error === "string" ? error : JSON.stringify(error)}`);
      console.log(`An unknown error occurred.: `, error);
    }
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
    process.exit(0);
  }
}

runProgram();