const numberFromEnv = (key: string, fallback: number) => {
	const raw = process.env[key]
	if (raw == null) return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : fallback
}

const numberFromEnvInt = (key: string, fallback: number) =>
	Math.max(1, Math.floor(numberFromEnv(key, fallback)))

export const benchOptions = {
	// Accuracy-first defaults: benchmarks are meant to find real bottlenecks,
	// not to be "CI fast". Override via env if you want quick local iteration.
	timeMs: numberFromEnv('PLUXEL_BENCH_TIME', 2_000),
	warmupTimeMs: numberFromEnv('PLUXEL_BENCH_WARMUP_TIME', 1_000),
	warmupIterations: numberFromEnv('PLUXEL_BENCH_WARMUP_ITERATIONS', 60),
	iterations: numberFromEnv('PLUXEL_BENCH_ITERATIONS', Number.NaN),
}

export const tolerancePct = numberFromEnv('PLUXEL_BENCH_TOLERANCE', 5)
export const strictMode = process.env.PLUXEL_BENCH_STRICT === '1'
export const debugBench = process.env.DEBUG_BENCH === '1'

// Representative topology sizes (defaults aim to surface bottlenecks).
export const scenarioSizes = {
	starLeaves: numberFromEnvInt('PLUXEL_BENCH_STAR_LEAVES', 200),
	chainLength: numberFromEnvInt('PLUXEL_BENCH_CHAIN_LENGTH', 200),
	// Extra "background" plugins to simulate real-world baselines where most plugins are independent.
	bigIndependent: numberFromEnvInt('PLUXEL_BENCH_BIG_INDEPENDENT', 800),
	// How many incremental ops per task invocation (higher = more "steady-state" realism).
	loops: numberFromEnvInt('PLUXEL_BENCH_LOOPS', 6),
	// Keys injected via @Config (measures config injection cost on restart).
	configKeys: numberFromEnvInt('PLUXEL_BENCH_CONFIG_KEYS', 200),
}

export const writeBaseline = process.env.PLUXEL_BENCH_WRITE_BASELINE === '1'

export const baselineEnvPath = process.env.PLUXEL_BENCH_BASELINE

