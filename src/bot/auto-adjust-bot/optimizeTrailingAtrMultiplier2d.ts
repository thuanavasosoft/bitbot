export type TrailingAtrMultiplierParams = {
  trailingAtrLength: number;
  trailMultiplier: number;
};

export type TrailingAtrMultiplierBounds = {
  trailingAtrLength: { min: number; max: number };
  trailMultiplier: { min: number; max: number };
};

export type OptimizationHistoryEntry = {
  params: TrailingAtrMultiplierParams;
  value: number;
};

export type OptimizeTrailingAtrMultiplierArgs = {
  objective: (params: TrailingAtrMultiplierParams) => Promise<number>;
  bounds: TrailingAtrMultiplierBounds;
  totalEvaluations?: number;
  initialRandom?: number;
  numCandidates?: number;
  kappa?: number;
  seedTrailingAtrLength?: number;
  seedTrailMultiplier?: number;
  verbose?: boolean;
};

export type OptimizeTrailingAtrMultiplierResult = {
  bestParams: TrailingAtrMultiplierParams;
  bestValue: number;
  history: OptimizationHistoryEntry[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const roundAtrLength = (value: number, min: number, max: number) =>
  clamp(Math.max(1, Math.round(value)), min, max);

const normalizeParams = (
  params: TrailingAtrMultiplierParams,
  bounds: TrailingAtrMultiplierBounds
): TrailingAtrMultiplierParams => ({
  trailingAtrLength: roundAtrLength(
    params.trailingAtrLength,
    bounds.trailingAtrLength.min,
    bounds.trailingAtrLength.max
  ),
  trailMultiplier: clamp(
    params.trailMultiplier,
    bounds.trailMultiplier.min,
    bounds.trailMultiplier.max
  ),
});

const randomInRange = (min: number, max: number) => min + Math.random() * (max - min);

const sampleRandomParams = (bounds: TrailingAtrMultiplierBounds): TrailingAtrMultiplierParams => ({
  trailingAtrLength: randomInRange(bounds.trailingAtrLength.min, bounds.trailingAtrLength.max),
  trailMultiplier: randomInRange(bounds.trailMultiplier.min, bounds.trailMultiplier.max),
});

const rbfKernel = (a: number[], b: number[], lengthScales: number[]) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] - b[i]) / lengthScales[i];
    sum += diff * diff;
  }
  return Math.exp(-0.5 * sum);
};

const invertMatrix = (matrix: number[][]): number[][] => {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(augmented[col][col]);
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(augmented[row][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = row;
      }
    }

    if (maxVal < 1e-12) {
      throw new Error("Matrix inversion failed (singular matrix)");
    }

    if (pivotRow !== col) {
      const tmp = augmented[col];
      augmented[col] = augmented[pivotRow];
      augmented[pivotRow] = tmp;
    }

    const pivot = augmented[col][col];
    for (let j = 0; j < 2 * n; j++) augmented[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = 0; j < 2 * n; j++) {
        augmented[row][j] -= factor * augmented[col][j];
      }
    }
  }

  return augmented.map((row) => row.slice(n));
};

const dot = (a: number[], b: number[]) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

const matVec = (mat: number[][], vec: number[]) =>
  mat.map((row) => dot(row, vec));

const buildGpModel = (points: number[][], values: number[]) => {
  const n = points.length;
  const lengthScales = [
    Math.max(
      1,
      (Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]))) / 3
    ),
    Math.max(
      1e-6,
      (Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]))) / 3
    ),
  ];
  const noise = 1e-6;
  const K = Array.from({ length: n }, (_, i) =>
    Array.from(
      { length: n },
      (_, j) => rbfKernel(points[i], points[j], lengthScales) + (i === j ? noise : 0)
    )
  );
  const KInv = invertMatrix(K);
  const KInvY = matVec(KInv, values);
  return { lengthScales, KInv, KInvY };
};

const ucbScore = (
  candidate: number[],
  points: number[][],
  model: ReturnType<typeof buildGpModel>,
  kappa: number
) => {
  const k = points.map((p) => rbfKernel(p, candidate, model.lengthScales));
  const mu = dot(k, model.KInvY);
  const v = matVec(model.KInv, k);
  const kxx = 1;
  const sigma2 = Math.max(0, kxx - dot(k, v));
  const sigma = Math.sqrt(sigma2);
  return { mu, sigma, ucb: mu + kappa * sigma };
};

export async function optimizeTrailingAtrAndMultiplier2D(
  args: OptimizeTrailingAtrMultiplierArgs
): Promise<OptimizeTrailingAtrMultiplierResult> {
  const totalEvaluations = args.totalEvaluations ?? 40;
  const initialRandom = args.initialRandom ?? 8;
  const numCandidates = args.numCandidates ?? 200;
  const kappa = args.kappa ?? 2;

  const bounds = args.bounds;
  const history: OptimizationHistoryEntry[] = [];
  const seen = new Set<string>();

  const evalParams = async (rawParams: TrailingAtrMultiplierParams) => {
    const params = normalizeParams(rawParams, bounds);
    const key = `${params.trailingAtrLength}|${params.trailMultiplier.toFixed(6)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const value = await args.objective(params);
    history.push({ params, value });
    if (args.verbose) {
      console.log("[optimizer] eval", {
        trailingAtrLength: params.trailingAtrLength,
        trailMultiplier: params.trailMultiplier,
        value,
      });
    }
    return { params, value };
  };

  if (
    typeof args.seedTrailingAtrLength === "number" &&
    typeof args.seedTrailMultiplier === "number"
  ) {
    await evalParams({
      trailingAtrLength: args.seedTrailingAtrLength,
      trailMultiplier: args.seedTrailMultiplier,
    });
  }

  while (history.length < totalEvaluations) {
    if (history.length < initialRandom) {
      const attempt = await evalParams(sampleRandomParams(bounds));
      if (!attempt) continue;
      continue;
    }

    const points = history.map((h) => [h.params.trailingAtrLength, h.params.trailMultiplier]);
    const values = history.map((h) => h.value);
    const model = buildGpModel(points, values);

    let bestCandidate = null;
    let bestScore = -Infinity;
    for (let i = 0; i < numCandidates; i++) {
      const candidate = sampleRandomParams(bounds);
      const normalized = normalizeParams(candidate, bounds);
      const score = ucbScore(
        [normalized.trailingAtrLength, normalized.trailMultiplier],
        points,
        model,
        kappa
      );
      if (score.ucb > bestScore) {
        bestScore = score.ucb;
        bestCandidate = normalized;
      }
    }

    if (bestCandidate) {
      await evalParams(bestCandidate);
    }
  }

  const bestEntry = history.reduce(
    (best, entry) => (entry.value > best.value ? entry : best),
    history[0]
  );

  return {
    bestParams: bestEntry.params,
    bestValue: bestEntry.value,
    history,
  };
}
