import { IPosition } from "@/services/exchange-service/exchange-type";
import BBUtil from "./bb-util";
import BBWSSignaling from "./bb-ws-signaling";
import BBStartingState from "./bb-states/bb-starting.state";
import BBWaitForEntryState from "./bb-states/bb-wait-for-entry.state";
import BBWaitForResolveState from "./bb-states/bb-wait-for-resolve.state";
import BBTrendWatcher from "./bb-trend-watcher";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import BBTgCmdHandler from "./bb-tg-cmd-handler";
import { SignalParams } from "./breakout-helpers";

export interface BBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

class BreakoutBot {
  runStartTs: Date = new Date();

  symbol: string;
  leverage: number;

  startQuoteBalance!: string;
  currQuoteBalance!: string;
  totalActualCalculatedProfit: number = 0;

  connectedClientsAmt: number = 0;

  sleepDurationAfterLiquidation: string;
  liquidationSleepFinishTs?: number;

  checkIntervalMinutes: number;

  isSleeping: boolean = false;
  betSize: number;
  signalParams: SignalParams;

  currActivePosition?: IPosition;
  entryWsPrice?: { price: number, time: Date };
  resolveWsPrice?: { price: number, time: Date };

  slippageAccumulation: number = 0;
  numberOfTrades: number = 0;
  pnlHistory: Array<{ timestamp: number; totalPnL: number }> = [];

  // Current signal state
  currentSignal: "Up" | "Down" | "Kangaroo" = "Kangaroo";
  currentSupport: number | null = null;
  currentResistance: number | null = null;
  lastSRUpdateTime: number = 0; // Timestamp of last support/resistance update
  lastExitTime: number = 0; // Timestamp of last position exit
  lastEntryTime: number = 0; // Timestamp of last position entry

  tradingMode: "against" | "follow" = "against"; // Trading mode: "against" enters opposite direction, "follow" enters same direction
  lastFlipTime: number = Date.now(); // Timestamp of last mode flip
  tradePnLHistory: Array<{ timestamp: number; pnl: number }> = []; // Individual trade PnL history

  bbUtil: BBUtil;
  bbWsSignaling: BBWSSignaling;
  bbTrendWatcher: BBTrendWatcher;
  bbTgCmdHandler: BBTgCmdHandler;

  startingState: BBStartingState;
  waitForEntryState: BBWaitForEntryState;
  waitForResolveState: BBWaitForResolveState;
  currentState: BBState;

  constructor() {
    this._verifyEnvs();

    this.runStartTs = new Date();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.BREAKOUT_BOT_LEVERAGE!);
    this.sleepDurationAfterLiquidation = process.env.BREAKOUT_BOT_SLEEP_DURATION_AFTER_LIQUIDATION!;
    this.betSize = Number(process.env.BREAKOUT_BOT_BET_SIZE!);
    this.checkIntervalMinutes = Number(process.env.BREAKOUT_BOT_CHECK_INTERVAL_MINUTES!);

    // Signal parameters with defaults from backtest
    this.signalParams = {
      N: Number(process.env.BREAKOUT_BOT_SIGNAL_N || 2),
      atr_len: Number(process.env.BREAKOUT_BOT_SIGNAL_ATR_LEN || 14),
      K: Number(process.env.BREAKOUT_BOT_SIGNAL_K || 5),
      eps: Number(process.env.BREAKOUT_BOT_SIGNAL_EPS || 0.0005),
      m_atr: Number(process.env.BREAKOUT_BOT_SIGNAL_M_ATR || 0.25),
      roc_min: Number(process.env.BREAKOUT_BOT_SIGNAL_ROC_MIN || 0.001),
      ema_period: Number(process.env.BREAKOUT_BOT_SIGNAL_EMA_PERIOD || 10),
      need_two_closes: process.env.BREAKOUT_BOT_SIGNAL_NEED_TWO_CLOSES === "true",
      vol_mult: Number(process.env.BREAKOUT_BOT_SIGNAL_VOL_MULT || 1.3),
    };

    this.bbUtil = new BBUtil(this);
    this.bbTrendWatcher = new BBTrendWatcher(this);

    this.bbTgCmdHandler = new BBTgCmdHandler(this);
    this.bbTgCmdHandler.handleTgMsgs();

    this.bbWsSignaling = new BBWSSignaling(this);
    this.bbWsSignaling.serveServer(Number(process.env.BREAKOUT_BOT_SERVER_PORT!))

    this.startingState = new BBStartingState(this);
    this.waitForEntryState = new BBWaitForEntryState(this);
    this.waitForResolveState = new BBWaitForResolveState(this);
    this.currentState = this.startingState;
  }

  private _verifyEnvs() {
    const necessaryEnvKeys = [
      "SYMBOL",
      "BREAKOUT_BOT_LEVERAGE",
      "BREAKOUT_BOT_SLEEP_DURATION_AFTER_LIQUIDATION",
      "BREAKOUT_BOT_BET_SIZE",
      "BREAKOUT_BOT_CHECK_INTERVAL_MINUTES",
      "BREAKOUT_BOT_SERVER_PORT",
    ];

    for (const envKey of necessaryEnvKeys) {
      const envVal = process.env[envKey];
      if (!envVal) {
        console.log(`Could not run breakout bot, ${envKey} (${process.env[envKey]}) is not valid please check`);
        process.exit(-1);
      }

      if (envKey === "BREAKOUT_BOT_SLEEP_DURATION_AFTER_LIQUIDATION") {
        const durationRegex = /^(?:(\d+h)(\d+m)?|\d+m)$/;
        if (!durationRegex.test(envVal)) {
          console.error(`Invalid time format: "${envVal}". Must be like "12h", "10h30m", or "24m".`);
          process.exit(-1);
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
        console.log("Current state is starting, next state is waiting for entry");
        this.currentState = this.waitForEntryState;
      } else if (this.currentState === this.waitForEntryState) {
        console.log("Current state is waiting for entry, next state is waiting for resolve");
        this.currentState = this.waitForResolveState;
      } else if (this.currentState === this.waitForResolveState) {
        console.log("Current state is waiting for resolve, next state is starting");
        this.currentState = this.startingState;
      }

      await this.currentState.onEnter();
    });

    await this.currentState.onEnter();
  }
}

export default BreakoutBot;

