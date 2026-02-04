import TMOBStartingState from "./tmob-states/tmob-starting.state";
import TMOBOptimizeTrailMultiplierState from "./tmob-states/tmob-optimize-trail-multiplier.state";
import TMOBWaitForResolveState from "./tmob-states/tmob-wait-for-resolve.state";
import TMOBWaitForSignalState from "./tmob-states/tmob-wait-for-signal.state";
import TMOBUtils from "./tmob-utils";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";
import TMOBCandleWatcher from "./tmob-candle-watcher";

export interface TMOBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}


class TrailMultiplierOptimizationBot {
  runStartTs?: Date;

  symbol: string;
  leverage: number;
  margin: number;

  startQuoteBalance?: string;
  currQuoteBalance?: string;
  totalActualCalculatedProfit: number = 0;
  slippageAccumulation: number = 0;

  currentSupport: number | null = null;
  currentResistance: number | null = null;
  triggerBufferPercentage: number;
  longTrigger: number | null = null;
  shortTrigger: number | null = null;
  lastSRUpdateTime: number = 0;
  lastExitTime: number = 0;
  lastEntryTime: number = 0;

  trailingStopTargets?: { side: TPositionSide; rawLevel: number; bufferedLevel: number; updatedAt: number };
  trailConfirmBars: number;
  trailingAtrLength: number;
  updateIntervalMinutes: number;
  optimizationWindowMinutes: number;
  nSignal: number;
  currActivePosition?: IPosition;


  isOpeningPosition: boolean = false;

  currTrailMultiplier?: number;
  lastCurrTrailMultiplierUpdateTs?: number;

  trailBoundStepSize: number;
  trailMultiplierBounds: { min: number; max: number };

  basePrecisiion!: number;
  pricePrecision!: number;

  tmobCandleWatcher: TMOBCandleWatcher;
  tmobUtils: TMOBUtils;
  startingState: TMOBStartingState;
  optimizeTrailMultiplierState: TMOBOptimizeTrailMultiplierState;
  waitForResolveState: TMOBWaitForResolveState;
  waitForSignalState: TMOBWaitForSignalState;
  currentState: TMOBState;

  constructor() {
    console.log("INITIATING TRAIL MULTIPLIER OPTIMIZATION BOT");

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.LEVERAGE!);
    this.margin = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_MARGIN!);
    this.triggerBufferPercentage = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRIGGER_BUFFER_PERCENTAGE! || 0);
    this.trailingAtrLength = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_N_SIGNAL_AND_ATR_LENGTH!);
    this.updateIntervalMinutes = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_UPDATE_INTERVAL_MINUTES!);
    this.optimizationWindowMinutes = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_OPTIMIZATION_WINDOW_MINUTES!);
    this.nSignal = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_N_SIGNAL_AND_ATR_LENGTH!);
    this.trailConfirmBars = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_CONFIRM_BARS! || 1);
    this.trailBoundStepSize = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_BOUND_STEP_SIZE!);
    this.trailMultiplierBounds = {
      min: Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_MULTIPLIER_BOUNDS_MIN!),
      max: Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_MULTIPLIER_BOUNDS_MAX!),
    };

    this.tmobUtils = new TMOBUtils(this);
    this.tmobCandleWatcher = new TMOBCandleWatcher(this);

    this.startingState = new TMOBStartingState(this);
    this.optimizeTrailMultiplierState = new TMOBOptimizeTrailMultiplierState(this);
    this.waitForResolveState = new TMOBWaitForResolveState(this);
    this.waitForSignalState = new TMOBWaitForSignalState(this);
    this.currentState = this.startingState;
  }

  async startMakeMoney() {
    eventBus.addListener(EEventBusEventType.StateChange, async (nextState: TMOBState) => {
      console.log("State change triggered, changing state");

      await this.currentState.onExit();

      if (this.currentState === this.startingState) {
        console.log("Current state is starting, next state is waiting for signal");
        this.currentState = this.waitForSignalState;
      } else if (this.currentState === this.waitForSignalState) {
        console.log("Current state is waiting for signal, next state is waiting for resolve");
        this.currentState = this.waitForResolveState;
      } else if (this.currentState === this.optimizeTrailMultiplierState) {
        console.log("Current state is optimizing trail multiplier, next state is waiting for signal");
        this.currentState = this.waitForSignalState;
      } else if (this.currentState === this.waitForResolveState) {
        if (!!nextState) this.currentState = nextState;
        else this.currentState = this.startingState;
      }

      await this.currentState.onEnter();
    });

    await this.currentState.onEnter();
  }
}

export default TrailMultiplierOptimizationBot;