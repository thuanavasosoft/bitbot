import dotenv from 'dotenv';
import TelegramService from "@/services/telegram.service";
import BudgetingBot from '@/bot/budgeting-bot/budgeting-bot';
import ExchangeService from '@/services/exchange-service/exchange-service';
import ComboBot from '@/bot/combo-bot/combo-bot';
import BreakoutBot from '@/bot/breakout-bot/breakout-bot';
import AutoAdjustBot from '@/bot/auto-adjust-bot/auto-adjust-bot';
import TrailMultiplierOptimizationBot from '@/bot/trail-multiplier-optimization-bot/trail-multiplier-optimization-bot';
import CombinationBot from '@/bot/combination-bot/combination-bot';

async function runProgram() {
  try {
    dotenv.config();

    await TelegramService.initialize();

    const botMode = process.env.BOT_MODE;
    console.log("BOT MODE: ", botMode);

    let symbols: string[];
    if (botMode === "combination_bot") {
      symbols = [];
      for (let i = 1; process.env[`COMB_BOT_${i}_SYMBOL`]; i++) {
        const s = (process.env[`COMB_BOT_${i}_SYMBOL`] || "").trim();
        if (s) symbols.push(s);
      }
      if (symbols.length === 0) throw "At least one bot required. Set COMB_BOT_1_SYMBOL (and optionally COMB_BOT_2_SYMBOL, ...).";
    } else {
      const symbol = process.env.SYMBOL;
      const symbolsEnv = process.env.SYMBOLS?.split(",") || [];
      if (!symbol && !symbolsEnv.length) throw "PLEASE SPECIFY EITHER SYMBOL OR SYMBOLS ACCORDING TO THE BOT";
      symbols = symbol ? [symbol] : symbolsEnv;
    }

    await ExchangeService.configure(
      process.env.API_KEY!,
      process.env.API_SECRET!,
      symbols,
    );

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
    } else if (botMode === "combination_bot" || botMode === "comb_bot") {
      const bot = new CombinationBot();
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