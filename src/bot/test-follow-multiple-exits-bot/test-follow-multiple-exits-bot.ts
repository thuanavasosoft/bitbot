import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import type { TEntryDirectionToTrend } from "@/utils/types.util";
import TFMEBWaitForBetSignalState from "./tfmeb-states/tfmeb-wait-for-bet-signal.state";
import TFMEBWaitForResolveSignalState from "./tfmeb-states/tfmeb-wait-for-resolve-signal.state";
import TFMEBStartingState from "./tfmeb-states/tfmeb-starting.state";
import GrokAiService, { type TAiCandleTrendDirection } from "@/services/grok-ai.service";
import TFMEBUtil from "./tfmeb-util";
import TFMEBTrendWatcher from "./tfmeb-trend-watcher";
import type { IPosition } from "@/services/exchange-service/exchange-type";
import TFMEBTgCmdHandler from "./tfmeb-tg-cmd-handler";
import { generateRunID } from "@/utils/strings.util";

export interface TFMEBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

class TestFollowMultipleExits {
  runStartTs: number = +new Date();
  runId: string = generateRunID();

  symbol: string;
  leverage: number;

  startQuoteBalance: string = "8000";
  currQuoteBalance: string = "8000";
  totalActualCalculatedProfit: number = 0;

  nextTrendCheckTs: number = 0;

  sleepDurationAfterLiquidation: string;
  liquidationSleepFinishTs?: number;

  aiTrendIntervalCheckInMinutes: number;
  candlesRollWindowInHours: number;
  betSize: number;
  betDirection: TEntryDirectionToTrend;

  commitedBetEntryTrend?: Omit<TAiCandleTrendDirection, "Kangaroo">;
  currActivePosition?: IPosition;
  entryWsPrice?: { price: number, time: Date };
  resolveWsPrice?: { price: number, time: Date };

  isEarlySundayHandled = false;
  isEarlyMondayHandled = false;

  lastCommitedEntrySignalTrend?: Omit<TAiCandleTrendDirection, "Kangaroo">;
  sameTrendAsBetTrendCount = 0;
  forceResolveOnSameAsBetTrendAmt = 0;

  slippageAccumulation: number = 0; // NOTE: negative means good, positive means bad
  numberOfTrades: number = 0; // NOTE: one position means 2 trades (open and close)

  startingState: TFMEBStartingState;
  waitForBetSignalState: TFMEBWaitForBetSignalState;
  waitForResolveSignalState: TFMEBWaitForResolveSignalState;
  currentState: TFMEBState;

  grokAi: GrokAiService;
  tfmebUtil: TFMEBUtil;
  tfmebTrendWatcher: TFMEBTrendWatcher;
  tfmebTgCmdHandler: TFMEBTgCmdHandler;

  constructor() {
    this._verifyEnvs();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.TFMEB_LEVERAGE);

    this.aiTrendIntervalCheckInMinutes = Number(process.env.TFMEB_AI_TREND_INTERVAL_CHECK_IN_MINUTES);
    this.candlesRollWindowInHours = Number(process.env.TFMEB_CANDLES_ROLL_WINDOW_IN_HOURS);
    this.sleepDurationAfterLiquidation = process.env.TFMEB_SLEEP_DURATION_AFTER_LIQUIDATION!
    this.betSize = Number(process.env.TFMEB_BET_SIZE)
    this.betDirection = process.env.TFMEB_BET_DIRECTION as TEntryDirectionToTrend;

    this.forceResolveOnSameAsBetTrendAmt = Number(process.env.BUDGETING_BOT_FORCE_RESOLVE_ON_CONSECUTIVE_SAME_BET_TREND_AMT)

    this.startingState = new TFMEBStartingState(this);
    this.waitForBetSignalState = new TFMEBWaitForBetSignalState(this);
    this.waitForResolveSignalState = new TFMEBWaitForResolveSignalState(this);
    this.currentState = this.startingState;

    this.grokAi = new GrokAiService();
    this.tfmebUtil = new TFMEBUtil(this);
    this.tfmebTrendWatcher = new TFMEBTrendWatcher(this);
    this.tfmebTgCmdHandler = new TFMEBTgCmdHandler(this);
    this.tfmebTgCmdHandler.handleTgMsgs();
  }

  private _verifyEnvs() {
    const necessaryEnvKeys = [
      "SYMBOL",
      "TFMEB_LEVERAGE",
      "TFMEB_AI_TREND_INTERVAL_CHECK_IN_MINUTES",
      "TFMEB_CANDLES_ROLL_WINDOW_IN_HOURS",
      "TFMEB_SLEEP_DURATION_AFTER_LIQUIDATION",
      "TFMEB_BET_SIZE",
      "TFMEB_BET_DIRECTION",
    ];

    for (const envKey of necessaryEnvKeys) {
      const envVal = process.env[envKey];
      if (!envVal) {
        console.log(`Could not run ai trend bot, ${envKey} (${process.env[envKey]}) is not valid please check`);
        process.exit(-1);
      }

      if (envKey === "BUDGETING_BOT_SUNDAY_SLEEP_TIME_AFTER_LIQUIDATION") {
        const durationRegex = /^(?:(\d+h)(\d+m)?|\d+m)$/;
        if (!durationRegex.test(envVal)) {
          console.error(`Invalid time format: "${envVal}". Must be like "12h", "10h30m", or "24m".`);
          process.exit(-1);
        }
      }

      if (envKey === "BUDGETING_BOT_BET_DIRECTION" && !(["against", "follow"] as TEntryDirectionToTrend[]).includes(envVal as TEntryDirectionToTrend)) {
        console.error(`invalid BUDGETING_BOT_BET_DIRECTION: ${envVal} must be value of either (against | follow)`);
        process.exit(-1);
      }
    }
  }

  async startMakeMoney() {
    console.log("Start making money");

    eventBus.addListener(EEventBusEventType.StateChange, async () => {
      console.log("State change triggered, changing state");

      await this.currentState.onExit();

      if (this.currentState === this.startingState) {
        console.log("Current state is starting, next state is waiting for consecutive trigger");
        this.currentState = this.waitForBetSignalState;
      } else if (this.currentState === this.waitForBetSignalState) {
        console.log("Current state is waiting for consecutive trigger, next state is waiting for switch trigger");
        this.currentState = this.waitForResolveSignalState;
      } else if (this.currentState === this.waitForResolveSignalState) {
        console.log("Current state is waiting for switchtrigger, next state is starting");
        this.currentState = this.startingState;
      }

      await this.currentState.onEnter();
    });

    await this.currentState.onEnter();
  }
}

export default TestFollowMultipleExits;