import { selectTaskNames } from './catalog.ts'

const numberFromEnv = (key: string, fallback: number) => {
	const raw = process.env[key]
	if (raw == null) return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : fallback
}

const numberFromEnvInt = (key: string, fallback: number) =>
	Math.max(1, Math.floor(numberFromEnv(key, fallback)))

export const benchOptions = {
	// Stable defaults; override env vars for quick local probes.
	timeMs: numberFromEnv('PLUXEL_BENCH_TIME', 2_000),
	warmupTimeMs: numberFromEnv('PLUXEL_BENCH_WARMUP_TIME', 1_000),
	warmupIterations: numberFromEnv('PLUXEL_BENCH_WARMUP_ITERATIONS', 60),
	iterations: numberFromEnv('PLUXEL_BENCH_ITERATIONS', Number.NaN),
}

export const tolerancePct = numberFromEnv('PLUXEL_BENCH_TOLERANCE', 5)
export const strictMode = process.env.PLUXEL_BENCH_STRICT === '1'
export const debugBench = process.env.DEBUG_BENCH === '1'

// Topology sizes.
export const scenarioSizes = {
	starLeaves: numberFromEnvInt('PLUXEL_BENCH_STAR_LEAVES', 200),
	chainLength: numberFromEnvInt('PLUXEL_BENCH_CHAIN_LENGTH', 200),
	// Background plugins for large-app scaling.
	bigIndependent: numberFromEnvInt('PLUXEL_BENCH_BIG_INDEPENDENT', 800),
	// Declared config fields.
	configKeys: numberFromEnvInt('PLUXEL_BENCH_CONFIG_KEYS', 200),
}

export const referenceEnvPath = process.env.PLUXEL_BENCH_REFERENCE

export const outputDirEnvPath = process.env.PLUXEL_BENCH_OUTPUT_DIR

export const verboseBench = process.env.PLUXEL_BENCH_VERBOSE === '1'

export const selectedTaskNames = selectTaskNames(process.env.PLUXEL_BENCH_TASKS)
