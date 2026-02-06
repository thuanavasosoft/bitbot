/**
 * Debug logging for TMOB. Only logs when DEBUG_MODE=true in the environment.
 */
export function isDebugMode(): boolean {
  return process.env.DEBUG_MODE === "true";
}

export function debugLog(...args: unknown[]): void {
  if (isDebugMode()) {
    console.log(...args);
  }
}
