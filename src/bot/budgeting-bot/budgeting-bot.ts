import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import type { TEntryDirectionToTrend } from "@/utils/types.util";
import BBWaitForBetSignalState from "./bb-states/bb-wait-for-bet-signal.state";
import BBWaitForResolveSignalState from "./bb-states/bb-wait-for-resolve-signal.state";
import BBStartingState from "./bb-states/bb-starting.state";
import GrokAiService, { type TAiCandleTrendDirection } from "@/services/grok-ai.service";
import BBUtil from "./bb-util";
import BBTrendWatcher from "./bb-trend-watcher";
import type { TPositionSide } from "@/services/exchange-service/exchange-type";
import BBWSSignaling from "./bb-ws-signaling";
import BBTgCmdHandler from "./bb-tg-cmd-handler";

export interface BBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

class BudgetingBot {
  runStartTs: number = +new Date();

  symbol: string;
  leverage: number;

  startQuoteBalance!: string;
  currQuoteBalance!: string;
  totalActualCalculatedProfit: number = 0;

  connectedClientsAmt: number = 0;
  nextTrendCheckTs: number = 0;

  sleepDurationAfterLiquidation: string;
  liquidationSleepFinishTs?: number;

  aiTrendIntervalCheckInMinutes: number;
  candlesRollWindowInHours: number;
  betSize: number;
  betDirection: TEntryDirectionToTrend;

  commitedBetEntryTrend?: Omit<TAiCandleTrendDirection, "Kangaroo">;
  currActiveOpenedPositionId?: number;
  currPositionSide?: TPositionSide;
  currPositionLiquidationPrice?: number;
  shouldResolvePositionTrends?: (TAiCandleTrendDirection)[] = [];

  isEarlySundayHandled = false;
  isEarlyMondayHandled = false;

  lastCommitedEntrySignalTrend?: Omit<TAiCandleTrendDirection, "Kangaroo">;
  sameTrendAsBetTrendCount = 0;
  forceResolveOnSameAsBetTrendAmt = 0;

  sundayStartGMTTimezone: number;
  sundayEndGMTTimezone: number;

  sundayAiTrendIntervalCheckInMinutes: number;
  sundayCandlesRollWindowInHours: number;
  sundayBetDirection: TEntryDirectionToTrend;

  startingState: BBStartingState;
  waitForBetSignalState: BBWaitForBetSignalState;
  waitForResolveSignalState: BBWaitForResolveSignalState;
  currentState: BBState;

  grokAi: GrokAiService;
  bbUtil: BBUtil;
  bbTrendWatcher: BBTrendWatcher;
  bbWSSignaling: BBWSSignaling;
  bbTgCmdHandler: BBTgCmdHandler;

  constructor() {
    this._verifyEnvs();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.BUDGETING_BOT_LEVERAGE!);

    this.sundayStartGMTTimezone = Number(process.env.BUDGETING_BOT_SUNDAY_START_TIMEZONE_IN_GMT!);
    this.sundayEndGMTTimezone = Number(process.env.BUDGETING_BOT_SUNDAY_END_TIMEZONE_IN_GMT!);

    this.aiTrendIntervalCheckInMinutes = Number(process.env.BUDGETING_BOT_AI_TREND_INTERVAL_CHECK_IN_MINUTES!);
    this.candlesRollWindowInHours = Number(process.env.BUDGETING_BOT_CANDLES_ROLL_WINDOW_IN_HOURS!);
    this.sleepDurationAfterLiquidation = process.env.BUDGETING_BOT_SLEEP_DURATION_AFTER_LIQUIDATION!;
    this.betSize = Number(process.env.BUDGETING_BOT_BET_SIZE!);
    this.betDirection = process.env.BUDGETING_BOT_BET_DIRECTION! as TEntryDirectionToTrend;

    this.sundayAiTrendIntervalCheckInMinutes = Number(process.env.BUDGETING_BOT_SUNDAY_AI_TREND_INTERVAL_CHECK_IN_MINUTES!);
    this.sundayCandlesRollWindowInHours = Number(process.env.BUDGETING_BOT_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS!);
    this.sundayBetDirection = process.env.BUDGETING_BOT_SUNDAY_BET_DIRECTION! as TEntryDirectionToTrend;

    this.forceResolveOnSameAsBetTrendAmt = Number(process.env.BUDGETING_BOT_FORCE_RESOLVE_ON_CONSECUTIVE_SAME_BET_TREND_AMT)

    this.startingState = new BBStartingState(this);
    this.waitForBetSignalState = new BBWaitForBetSignalState(this);
    this.waitForResolveSignalState = new BBWaitForResolveSignalState(this);
    this.currentState = this.startingState;

    this.grokAi = new GrokAiService();
    this.bbUtil = new BBUtil(this);
    this.bbTrendWatcher = new BBTrendWatcher(this);
    this.bbWSSignaling = new BBWSSignaling(this);
    this.bbWSSignaling.serveServer(Number(process.env.BUDGETING_BOT_SERVER_PORT!));
    this.bbTgCmdHandler = new BBTgCmdHandler(this);
    this.bbTgCmdHandler.handleTgMsgs();
  }

  private _verifyEnvs() {
    const necessaryEnvKeys = [
      "SYMBOL",
      "BUDGETING_BOT_LEVERAGE",
      "BUDGETING_BOT_SUNDAY_START_TIMEZONE_IN_GMT",
      "BUDGETING_BOT_SUNDAY_END_TIMEZONE_IN_GMT",
      "BUDGETING_BOT_AI_TREND_INTERVAL_CHECK_IN_MINUTES",
      "BUDGETING_BOT_CANDLES_ROLL_WINDOW_IN_HOURS",
      "BUDGETING_BOT_SLEEP_DURATION_AFTER_LIQUIDATION",
      "BUDGETING_BOT_BET_SIZE",
      "BUDGETING_BOT_BET_DIRECTION",
      "BUDGETING_BOT_SUNDAY_AI_TREND_INTERVAL_CHECK_IN_MINUTES",
      "BUDGETING_BOT_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS",
      "BUDGETING_BOT_SUNDAY_BET_DIRECTION",
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

export default BudgetingBot;