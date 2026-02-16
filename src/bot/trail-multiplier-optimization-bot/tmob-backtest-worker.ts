/**
 * Worker thread entry for TMOB backtest. Receives shared args + trail multiplier,
 * runs tmobRunBacktest, posts back { trailMultiplier, totalPnL }.
 * Used by tmob-backtest-worker-pool to parallelize optimization across CPU cores.
 */

import { parentPort } from "worker_threads";
import { tmobRunBacktest } from "./tmob-backtest";
import type { TMOBRunBacktestArgs } from "./tmob-types";

export type TMOBWorkerRunPayload = {
  type: "runBatch";
  sharedArgs: Omit<TMOBRunBacktestArgs, "trailMultiplier">;
  jobs: Array<{ jobId: number; trailMultiplier: number }>;
};

export type TMOBWorkerResultPayload = {
  type: "batchResult";
  results: Array<{ jobId: number; trailMultiplier: number; totalPnL: number }>;
};

export type TMOBWorkerErrorPayload = {
  type: "error";
  jobId: number;
  trailMultiplier: number;
  error: string;
};

function runBatch(payload: TMOBWorkerRunPayload): void {
  const { sharedArgs, jobs } = payload;
  const results: Array<{ jobId: number; trailMultiplier: number; totalPnL: number }> = [];

  for (const { jobId, trailMultiplier } of jobs) {
    try {
      const backtestResult = tmobRunBacktest({
        ...sharedArgs,
        trailMultiplier,
      });
      results.push({
        jobId,
        trailMultiplier,
        totalPnL: backtestResult.summary.totalPnL,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      parentPort?.postMessage({
        type: "error",
        jobId,
        trailMultiplier,
        error: errorMessage,
      } satisfies TMOBWorkerErrorPayload);
    }
  }

  parentPort?.postMessage({
    type: "batchResult",
    results,
  } satisfies TMOBWorkerResultPayload);
  process.exit(0);
}

parentPort?.on("message", (payload: TMOBWorkerRunPayload) => {
  if (payload.type === "runBatch") {
    runBatch(payload);
  }
});
