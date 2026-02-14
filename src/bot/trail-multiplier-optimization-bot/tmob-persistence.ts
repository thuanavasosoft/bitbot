import DatabaseService from "@/services/database.service";
import { trailMultiplierOptimizationBotAction } from "db/drizzle/schema";
import type { TMOBActionType, TMOBBotStateSnapshot } from "./tmob-action-types";

/**
 * Persists a TMOB action row. Does not throw; logs and ignores errors so the bot keeps running
 * when the database is not configured or unavailable.
 *
 * @param runId - Run identifier
 * @param actionType - Type of action (STARTING, ENTERED_POSITION, etc.)
 * @param actionPayload - Action-specific data (order, position, message, etc.)
 * @param botState - Exact bot state at the time of this action (current state name, balances, position info, etc.)
 */
export async function persistTMOBAction(
  runId: string,
  actionType: TMOBActionType,
  actionPayload: Record<string, unknown>,
  botState: TMOBBotStateSnapshot
): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    if (!DatabaseService.db) {
      console.warn("[TMOB persistence] Database not configured, skipping persist.");
      return;
    }
    const meta = {
      ...actionPayload,
      botState,
    };
    await DatabaseService.db.insert(trailMultiplierOptimizationBotAction).values({
      runId,
      actionType,
      meta: meta as object,
      timestamp,
    });
  } catch (err) {
    console.error("[TMOB persistence] Failed to persist action:", actionType, err);
  }
}
