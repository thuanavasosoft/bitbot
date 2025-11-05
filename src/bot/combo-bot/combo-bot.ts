import { IPosition } from "@/services/exchange-service/exchange-type";
import GrokAiService, { TAiCandleTrendDirection } from "@/services/grok-ai.service";
import CBUtil from "./cb-util";
import CBWSServer from "./cb-ws-signaling";
import CBStartingState from "./cb-states/cb-starting.state";
import CBWaitForEntryState from "./cb-states/cb-wait-for-entry.state";
import CBWaitForResolveState from "./cb-states/cb-wait-for-resolve.state";
import CBTrendWatcher, { ICandlesData } from "./cb-trend-watcher";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import CBTgCmdHandler from "./cb-tg-cmd-handler";
import { generateRunID } from "@/utils/strings.util";
import WsClient from "./cb-tm-ws-client";

export interface CBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

export type TBetRuleVal = "skip" | "short" | "long";
export type IBetRule = {
  [key in TAiCandleTrendDirection]: {
    [key in TAiCandleTrendDirection]: TBetRuleVal;
  }
};

export const comboBetRulesDefaultValue = {
  Up: {
    Up: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    },
    Down: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    },
    Kangaroo: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    }
  },
  Down: {
    Up: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    },
    Down: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    },
    Kangaroo: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    }
  },
  Kangaroo: {
    Up: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    },
    Down: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    },
    Kangaroo: {
      entriesAmt: 0,
      pnl: 0,
      liquidatedCount: 0,
    }
  }
};

class ComboBot {
  runId: string = generateRunID();
  runStartTs: Date = new Date();

  symbol: string;
  leverage: number;

  startQuoteBalance!: string;
  currQuoteBalance!: string;
  totalActualCalculatedProfit: number = 0;

  connectedClientsAmt: number = 0;
  nextBigTrendCheckTs: number = 0;
  nextSmallTrendCheckTs: number = 0;

  sleepDurationAfterLiquidation: string;
  liquidationSleepFinishTs?: number;

  bigAiTrendIntervalCheckInMinutes: number;
  smallAiTrendIntervalCheckInMinutes: number;

  bigCandlesRollWindowInHours: number;
  smallCandlesRollWindowInHours: number;

  currCommitedTrendCombo?: { big: TAiCandleTrendDirection, small: TAiCandleTrendDirection };
  trendComboRecords: { [big in TAiCandleTrendDirection]: { [small in TAiCandleTrendDirection]: { entriesAmt: number, pnl: number, liquidatedCount: number } } } = comboBetRulesDefaultValue;

  isSleeping: boolean = false;
  betSize: number;
  betRules: IBetRule;

  currActivePosition?: IPosition;
  entryWsPrice?: { price: number, time: Date };
  resolveWsPrice?: { price: number, time: Date };
  betRuleValsToResolvePosition?: (TBetRuleVal)[] = [];
  nextRunForceBetCandlesDatas?: { big: ICandlesData, small: ICandlesData };

  slippageAccumulation: number = 0;
  numberOfTrades: number = 0;

  grokAi: GrokAiService;

  cbUtil: CBUtil;
  cbWsServer: CBWSServer;
  cbWsClient: WsClient;
  cbTrendWatcher: CBTrendWatcher;
  cbTgCmdHandler: CBTgCmdHandler;

  startingState: CBStartingState;
  waitForEntryState: CBWaitForEntryState;
  waitForResolveState: CBWaitForResolveState;
  currentState: CBState;

  constructor() {
    this._verifyEnvs();

    this.runStartTs = new Date();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.COMBO_BOT_LEVERAGE!);

    this.sleepDurationAfterLiquidation = process.env.COMBO_BOT_SLEEP_DURATION_AFTER_LIQUIDATION!;
    this.betSize = Number(process.env.COMBO_BOT_BET_SIZE!);

    this.bigCandlesRollWindowInHours = Number(process.env.COMBO_BOT_BIG_CANDLES_ROLL_WINDOW_IN_HOURS!);
    this.smallCandlesRollWindowInHours = Number(process.env.COMBO_BOT_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS!);

    this.bigAiTrendIntervalCheckInMinutes = Number(process.env.COMBO_BOT_BIG_AI_TREND_INTERVAL_CHECK_IN_MINUTES!);
    this.smallAiTrendIntervalCheckInMinutes = Number(process.env.COMBO_BOT_SMALL_AI_TREND_INTERVAL_CHECK_IN_MINUTES!);
    if (this.bigAiTrendIntervalCheckInMinutes % this.smallAiTrendIntervalCheckInMinutes !== 0) {
      throw `Small candles check interval in minutes (${this.smallAiTrendIntervalCheckInMinutes} is not overlapping with big trend check interval in minutes ${this.bigAiTrendIntervalCheckInMinutes})`
    }

    this.betRules = JSON.parse(process.env.COMBO_BOT_BET_RULES!);

    this.grokAi = new GrokAiService();

    this.cbUtil = new CBUtil(this);
    this.cbTrendWatcher = new CBTrendWatcher(this);

    this.cbTgCmdHandler = new CBTgCmdHandler(this);
    this.cbTgCmdHandler.handleTgMsgs();

    this.cbWsServer = new CBWSServer(this);
    this.cbWsServer.serveServer(Number(process.env.COMBO_BOT_SERVER_PORT!))

    this.cbWsClient = new WsClient(process.env.TREND_MANAGER_WS_URL!);

    this.startingState = new CBStartingState(this);
    this.waitForEntryState = new CBWaitForEntryState(this);
    this.waitForResolveState = new CBWaitForResolveState(this);
    this.currentState = this.startingState;
  }

  private _verifyEnvs() {
    const necessaryEnvKeys = [
      "SYMBOL",
      "COMBO_BOT_LEVERAGE",
      "COMBO_BOT_SLEEP_DURATION_AFTER_LIQUIDATION",
      "COMBO_BOT_BET_SIZE",
      "COMBO_BOT_BIG_CANDLES_ROLL_WINDOW_IN_HOURS",
      "COMBO_BOT_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS",
      "COMBO_BOT_BIG_AI_TREND_INTERVAL_CHECK_IN_MINUTES",
      "COMBO_BOT_SMALL_AI_TREND_INTERVAL_CHECK_IN_MINUTES",
      "COMBO_BOT_BET_RULES",
    ];

    for (const envKey of necessaryEnvKeys) {
      const envVal = process.env[envKey];
      if (!envVal) {
        console.log(`Could not run ai trend bot, ${envKey} (${process.env[envKey]}) is not valid please check`);
        process.exit(-1);
      }

      if (envKey === "COMBO_BOT_SLEEP_DURATION_AFTER_LIQUIDATION") {
        const durationRegex = /^(?:(\d+h)(\d+m)?|\d+m)$/;
        if (!durationRegex.test(envVal)) {
          console.error(`Invalid time format: "${envVal}". Must be like "12h", "10h30m", or "24m".`);
          process.exit(-1);
        }
      }

      if (envKey === "COMBO_BOT_BET_RULES") {
        const keys: TAiCandleTrendDirection[] = ["Down", "Up", "Kangaroo"];
        try {
          const parsed = JSON.parse(process.env.COMBO_BOT_BET_RULES!) as IBetRule;
          for (const key of keys) {
            for (const key2 of keys) {
              if (!(["long", "short", "skip"] as TBetRuleVal[]).includes(parsed[key]?.[key2])) throw `Wrong COMBO_BOT_BET_RULES env value please check again`;
            }
          }
        } catch (e) {
          throw `Error on parsing COMBO_BOT_BET_RULES .env values ${e}`
        }
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
        this.currentState = this.waitForEntryState;
      } else if (this.currentState === this.waitForEntryState) {
        console.log("Current state is waiting for consecutive trigger, next state is waiting for switch trigger");
        this.currentState = this.waitForResolveState;
      } else if (this.currentState === this.waitForResolveState) {
        console.log("Current state is waiting for switchtrigger, next state is starting");
        this.currentState = this.startingState;
      }

      await this.currentState.onEnter();
    });

    await this.currentState.onEnter();
  }
}

export default ComboBot;