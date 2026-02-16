/**
 * Worker pool to run TMOB backtests in parallel across CPU cores.
 * Distributes trail multiplier values across worker threads and aggregates results.
 */

import { Worker } from "worker_threads";
import { cpus } from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { TMOBRunBacktestArgs } from "./tmob-types";
import type { TMOBWorkerRunPayload, TMOBWorkerResultPayload, TMOBWorkerErrorPayload } from "./tmob-backtest-worker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type BacktestJobResult = { trailMultiplier: number; totalPnL: number };

/**
 * Run backtests for multiple trail multiplier values in parallel using a worker pool.
 * Uses (cpuCount - 1) workers, minimum 1, so the main thread is not starved.
 *
 * @param sharedArgs - Backtest args common to all runs (candles, symbol, etc.). Must not include trailMultiplier.
 * @param trailMultipliers - List of trail multiplier values to test
 * @returns Array of { trailMultiplier, totalPnL } in arbitrary order
 */
export async function runBacktestPool(
  sharedArgs: Omit<TMOBRunBacktestArgs, "trailMultiplier">,
  trailMultipliers: number[]
): Promise<BacktestJobResult[]> {
  if (trailMultipliers.length === 0) {
    return [];
  }

  const numWorkers = Math.max(1, cpus().length - 1);
  const numJobs = trailMultipliers.length;

  // Round-robin assign jobs to workers so load is balanced
  const jobAssignments: Array<Array<{ jobId: number; trailMultiplier: number }>> = Array.from(
    { length: numWorkers },
    () => []
  );
  trailMultipliers.forEach((trailMultiplier, index) => {
    jobAssignments[index % numWorkers].push({ jobId: index, trailMultiplier });
  });

  const workerPath = path.join(__dirname, "tmob-backtest-worker.js");
  const actualWorkers = Math.min(numWorkers, trailMultipliers.length);

  const results: BacktestJobResult[] = new Array(numJobs);
  let completed = 0;
  const errors: Array<{ jobId: number; trailMultiplier: number; error: string }> = [];

  const runWorker = (workerIndex: number): Promise<void> => {
    const jobs = jobAssignments[workerIndex];
    if (!jobs.length) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: undefined,
        execArgv: [],
      });

      worker.on("message", (payload: TMOBWorkerResultPayload | TMOBWorkerErrorPayload) => {
        if (payload.type === "batchResult") {
          for (const r of payload.results) {
            results[r.jobId] = { trailMultiplier: r.trailMultiplier, totalPnL: r.totalPnL };
          }
          completed += payload.results.length;
        } else if (payload.type === "error") {
          errors.push({
            jobId: payload.jobId,
            trailMultiplier: payload.trailMultiplier,
            error: payload.error,
          });
          completed += 1;
        }
      });

      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code}`));
        } else {
          resolve();
        }
      });

      const payload: TMOBWorkerRunPayload = {
        type: "runBatch",
        sharedArgs,
        jobs,
      };
      worker.postMessage(payload);
    });
  };

  await Promise.all(
    Array.from({ length: actualWorkers }, (_, i) => runWorker(i))
  );

  if (errors.length > 0) {
    const firstError = errors[0];
    throw new Error(
      `TMOB backtest worker error (${errors.length} job(s) failed): ${firstError.error} (trailMultiplier=${firstError.trailMultiplier})`
    );
  }

  return results;
}
