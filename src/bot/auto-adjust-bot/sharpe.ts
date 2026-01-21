export function calculateSharpeRatio(returns: number[]): number {
  if (!returns || returns.length < 2) return 0;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (!Number.isFinite(stdDev) || stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(returns.length);
}
