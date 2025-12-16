import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bench, type TaskResult, type TaskResultRuntimeInfo, type TaskResultTimestampProviderInfo, type TaskResultWithStatistics } from 'tinybench'

import { Context } from '@pluxel/core/test'
import { PluginA, PluginB, PluginC } from '../plugins'

type CommitResult = Awaited<ReturnType<Context['registry']['commit']>>

const numberFromEnv = (key: string, fallback: number) => {
	const raw = process.env[key]
	if (raw == null) return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : fallback
}

const benchOptions = {
	time: numberFromEnv('PLUXEL_BENCH_TIME', 350),
	warmupTime: numberFromEnv('PLUXEL_BENCH_WARMUP_TIME', 150),
	warmupIterations: numberFromEnv('PLUXEL_BENCH_WARMUP_ITERATIONS', 24),
	iterations: numberFromEnv('PLUXEL_BENCH_ITERATIONS', Number.NaN),
}

const bench = new Bench({
	time: benchOptions.time,
	warmupTime: benchOptions.warmupTime,
	warmupIterations: benchOptions.warmupIterations,
	iterations: Number.isFinite(benchOptions.iterations) ? benchOptions.iterations : undefined,
})

const tolerancePct = numberFromEnv('PLUXEL_BENCH_TOLERANCE', 5)
const strictMode = process.env.PLUXEL_BENCH_STRICT === '1'

if (process.env.DEBUG_BENCH === '1') {
	console.log('[bench] cwd:', process.cwd())
}

type CompletedResult = TaskResultWithStatistics & TaskResultRuntimeInfo & TaskResultTimestampProviderInfo
const assertCompleted = (
	taskName: string,
	result: TaskResult & TaskResultRuntimeInfo & TaskResultTimestampProviderInfo,
): CompletedResult => {
	if (result.state !== 'completed') {
		throw new Error(`Benchmark task "${taskName}" did not complete (state: ${result.state})`)
	}
	return result
}

const silencePluginLogs = () => {
	const methods: Array<'trace' | 'debug' | 'info' | 'warn' | 'error' | 'log'> = [
		'trace',
		'debug',
		'info',
		'warn',
		'error',
		'log',
	]
	const restoreStack = methods.map((method) => {
		const original = console[method] as (...args: unknown[]) => void
		;(console as any)[method] = () => {}
		return () => {
			;(console as any)[method] = original
		}
	})
	return () => {
		while (restoreStack.length) {
			const restore = restoreStack.pop()
			restore?.()
		}
	}
}

const ensureOk = (result: CommitResult) => {
	if (!result.ok) {
		throw result.err ?? new Error('Commit failed')
	}
}

bench
	.add('load/unload A+B+C', async () => {
		const ctx = new Context({ name: 'bench-load' })
		const { pluginRegistry } = ctx.registry

		pluginRegistry.registerPlugin(PluginB)
		pluginRegistry.registerPlugin(PluginC)
		pluginRegistry.registerPlugin(PluginA)
		ensureOk(await ctx.registry.commit())

		pluginRegistry.unregisterPlugin(PluginA)
		pluginRegistry.unregisterPlugin(PluginB)
		pluginRegistry.unregisterPlugin(PluginC)
		ensureOk(await ctx.registry.commit())

		ctx.disposeAll()
	})
	.add('reload PluginA', async () => {
		const ctx = new Context({ name: 'bench-reload' })
		const { pluginRegistry } = ctx.registry

		pluginRegistry.registerPlugin(PluginB)
		pluginRegistry.registerPlugin(PluginA)
		ensureOk(await ctx.registry.commit())

		pluginRegistry.reloadPlugin(PluginA)
		ensureOk(await ctx.registry.commit())

		ctx.disposeAll()
	})

const round = (value: number, digits = 3) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : value
const pct = (value: number, digits = 2) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : value
const safe = (value: number | undefined | null, digits = 3) =>
	value == null ? null : round(value, digits)
const toDisplay = (value: number | null | undefined) =>
	value == null || Number.isNaN(value) ? '—' : value.toLocaleString()
const pctDisplay = (value: number | null | undefined) =>
	value == null || Number.isNaN(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const countDisplay = (value: number | null | undefined) =>
	value == null || Number.isNaN(value) ? '—' : value.toLocaleString()
const metricSummary = (
	current: number | null | undefined,
	delta: number | null | undefined,
	baseline: number | null | undefined,
) => {
	if (current == null || Number.isNaN(current)) {
		if (baseline == null || Number.isNaN(baseline)) return '—'
		return `— · base ${baseline.toLocaleString()}`
	}
	const parts = [current.toLocaleString()]
	const deltaText = delta == null || Number.isNaN(delta) ? null : pctDisplay(delta)
	if (deltaText && deltaText !== '—') {
		parts.push(`Δ ${deltaText}`)
	}
	if (baseline != null && !Number.isNaN(baseline)) {
		parts.push(`base ${baseline.toLocaleString()}`)
	}
	return parts.join(' · ')
}
const ratioPct = (current: number, baseline: number) =>
	baseline === 0 ? null : ((current - baseline) / baseline) * 100

const restore = silencePluginLogs()
await bench.run()
restore()

const recordedAt = new Date().toISOString()
const runtime = {
	name: bench.runtime,
	version: bench.runtimeVersion,
}

const rows = bench.tasks.map((task) => {
	const result = assertCompleted(task.name, task.result)
	const { latency, throughput, totalTime } = result
	const runs =
		latency.samplesCount ??
		throughput.samplesCount ??
		(Number.isFinite(task.runs) ? task.runs : undefined)
	return {
		name: task.name,
		runs: runs ?? null,
		totalTimeMs: round(totalTime),
		opsMean: round(throughput.mean),
		opsMin: round(throughput.min),
		opsMax: round(throughput.max),
		opsRmePct: pct(throughput.rme),
		latencyMeanMs: round(latency.mean),
		latencyP50Ms: safe(latency.p50),
		latencyP75Ms: safe(latency.p75),
		latencyP99Ms: safe(latency.p99),
		latencyMaxMs: round(latency.max),
		latencyRmePct: pct(latency.rme),
		latencySdMs: round(latency.sd),
	}
})

console.log('')
console.table(
	rows.map(
		({
			name,
			runs,
			opsMean,
			opsMin,
			opsMax,
			opsRmePct,
			latencyMeanMs,
			latencyP50Ms,
			latencyP75Ms,
			latencyP99Ms,
			latencyMaxMs,
		}) => ({
			Task: name,
			'Ops/sec (mean)': opsMean,
			'Ops/sec (min)': opsMin,
			'Ops/sec (max)': opsMax,
			'Ops ±RME (%)': opsRmePct,
			'Latency mean (ms)': latencyMeanMs,
			'p50 (ms)': toDisplay(latencyP50Ms),
			'p75 (ms)': toDisplay(latencyP75Ms),
			'p99 (ms)': toDisplay(latencyP99Ms),
			'Max (ms)': latencyMaxMs,
			Runs: runs,
		}),
	),
)

type BenchRow = (typeof rows)[number]

type ComparisonRow = {
	name: string
	baselineOpsMean: number | null
	baselineLatencyMeanMs: number | null
	opsMean: number | null
	latencyMeanMs: number | null
	opsDeltaPct: number | null
	latencyDeltaPct: number | null
	runs: number | null
	status: 'measured' | 'new' | 'missing'
}

const baselineEnvPath = process.env.PLUXEL_BENCH_BASELINE
type BaselineReport = { tasks: BenchRow[]; recordedAt?: string }
let baselineReport: BaselineReport | null = null

const resolveBaselinePath = (input: string): string | null => {
	if (path.isAbsolute(input)) return input
	const candidates = [
		input,
		path.resolve(process.cwd(), input),
		path.resolve(process.cwd(), '..', '..', input),
	]
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}
	return null
}

const baselinePath = baselineEnvPath ? resolveBaselinePath(baselineEnvPath) : null

if (process.env.DEBUG_BENCH === '1' && baselineEnvPath) {
	console.log('[bench] baseline candidates resolved to:', baselinePath ?? '(not found)')
}

if (baselinePath && existsSync(baselinePath)) {
	try {
		const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
		if (Array.isArray(parsed?.tasks)) {
			baselineReport = {
				tasks: parsed.tasks as BenchRow[],
				recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : undefined,
			}
		}
		if (process.env.DEBUG_BENCH === '1') {
			console.log('[bench] Loaded baseline from', baselinePath)
		}
	} catch (error) {
		console.warn('[bench] Could not load baseline report:', error)
	}
} else if (baselineEnvPath && process.env.DEBUG_BENCH === '1') {
	console.log('[bench] Baseline path not found:', baselineEnvPath)
}

const comparison: ComparisonRow[] = rows.map(
	(row): ComparisonRow => ({
		name: row.name,
		baselineOpsMean: null,
		baselineLatencyMeanMs: null,
		opsMean: row.opsMean,
		latencyMeanMs: row.latencyMeanMs,
		opsDeltaPct: null,
		latencyDeltaPct: null,
		runs: row.runs,
		status: 'new',
	}),
)

if (baselineReport?.tasks) {
	const baselineIndex = new Map<string, BenchRow>()
	for (const task of baselineReport.tasks) {
		baselineIndex.set(task.name, task as BenchRow)
	}
	for (const item of comparison) {
		const baseline = baselineIndex.get(item.name)
		if (!baseline) continue
		item.baselineOpsMean = baseline.opsMean ?? null
		item.baselineLatencyMeanMs = baseline.latencyMeanMs ?? null
		item.opsDeltaPct =
			item.opsMean != null && baseline.opsMean != null
				? pct(ratioPct(item.opsMean, baseline.opsMean) ?? Number.NaN)
				: null
		item.latencyDeltaPct =
			item.latencyMeanMs != null && baseline.latencyMeanMs != null
				? pct(ratioPct(item.latencyMeanMs, baseline.latencyMeanMs) ?? Number.NaN)
				: null
		item.status = 'measured'
		baselineIndex.delete(item.name)
	}

	for (const baseline of baselineIndex.values()) {
		comparison.push({
			name: baseline.name,
			baselineOpsMean: baseline.opsMean ?? null,
			baselineLatencyMeanMs: baseline.latencyMeanMs ?? null,
			opsMean: null,
			latencyMeanMs: null,
			opsDeltaPct: null,
			latencyDeltaPct: null,
			runs: null,
			status: 'missing',
		})
	}
}

if (comparison.length) {
	console.log('\nComparison vs baseline:')
	console.table(
		comparison.map((item) => ({
			Task: item.name,
			Status: item.status,
			'Ops Δ%': pctDisplay(item.opsDeltaPct),
			'Latency Δ%': pctDisplay(item.latencyDeltaPct),
			'Baseline ops': toDisplay(item.baselineOpsMean),
			'Current ops': toDisplay(item.opsMean),
			'Baseline latency (ms)': toDisplay(item.baselineLatencyMeanMs),
			'Current latency (ms)': toDisplay(item.latencyMeanMs),
		})),
	)
}

const regressions = comparison.filter((item) => {
	if (item.status !== 'measured') return false
	const opsDelta = item.opsDeltaPct ?? 0
	const latencyDelta = item.latencyDeltaPct ?? 0
	return opsDelta < -tolerancePct || latencyDelta > tolerancePct
})

if (regressions.length) {
	console.warn('\nPotential regressions detected (threshold:', tolerancePct, '%):')
	for (const item of regressions) {
		console.warn(
			`- ${item.name}: ops Δ ${pctDisplay(item.opsDeltaPct)}, latency Δ ${pctDisplay(item.latencyDeltaPct)}`,
		)
	}
	if (strictMode) {
		console.error(
			'[bench] Failing build due to regressions exceeding tolerance. Set PLUXEL_BENCH_STRICT=0 to disable.',
		)
		process.exitCode = 1
	}
}

const report = {
	recordedAt,
	runtime,
	options: {
		timeMs: benchOptions.time,
		warmupTimeMs: benchOptions.warmupTime,
		warmupIterations: benchOptions.warmupIterations,
		minIterations: Number.isFinite(benchOptions.iterations) ? benchOptions.iterations : null,
	},
	tasks: rows,
	keyMetrics: rows.map((row) => ({
		name: row.name,
		throughputOpsPerSecond: row.opsMean,
		throughputMarginOfErrorPct: row.opsRmePct,
		latencyMeanMs: row.latencyMeanMs,
		latencyP99Ms: row.latencyP99Ms,
		runs: row.runs,
	})),
	comparison: comparison.length
		? comparison.map((item) => ({
				name: item.name,
				baselineOpsMean: item.baselineOpsMean,
				opsMean: item.opsMean,
				opsDeltaPct: item.opsDeltaPct,
				baselineLatencyMeanMs: item.baselineLatencyMeanMs,
				latencyMeanMs: item.latencyMeanMs,
				latencyDeltaPct: item.latencyDeltaPct,
				runs: item.runs,
				status: item.status,
			}))
		: undefined,
	baseline: baselineReport
		? {
				recordedAt: baselineReport.recordedAt ?? null,
			}
		: undefined,
}

const benchmarksDir = new URL('../../benchmarks/', import.meta.url)
mkdirSync(fileURLToPath(benchmarksDir), { recursive: true })

writeFileSync(new URL('plugin-lifecycle.json', benchmarksDir), JSON.stringify(report, null, 2))

const baselineRecordedAt = baselineReport?.recordedAt ?? null

const statusLabel = (item: ComparisonRow) => {
	switch (item.status) {
		case 'measured':
			return '✅ tracked'
		case 'new':
			return '🆕 new'
		case 'missing':
			return '⚠️ missing'
		default:
			return item.status
	}
}

const markdownLines = [
	'# Plugin lifecycle benchmark',
	'',
	`- Recorded at: ${recordedAt}`,
	`- Runtime: ${runtime.name} ${runtime.version}`,
	`- Target benchmark time: ${benchOptions.time}ms (warmup ${benchOptions.warmupTime}ms)`,
	`- Baseline: ${baselineRecordedAt ?? 'not available'}`,
	`- Regression tolerance: ±${tolerancePct}%`,
	'',
	'## Summary',
	'',
	'| Task | Ops/sec | Latency mean (ms) | Status | Runs |',
	'| --- | --- | --- | --- | ---: |',
	...comparison.map((item) =>
		[
			item.name,
			metricSummary(item.opsMean, item.opsDeltaPct, item.baselineOpsMean),
			metricSummary(item.latencyMeanMs, item.latencyDeltaPct, item.baselineLatencyMeanMs),
			statusLabel(item),
			item.runs != null ? item.runs.toLocaleString() : '—',
		]
			.map((cell) => String(cell))
			.join(' | '),
	),
	'',
	...(regressions.length
		? [
				'> ⚠️ Potential regressions detected beyond tolerance:',
				...regressions.map(
					(item) =>
						`> - ${item.name}: ops ${pctDisplay(item.opsDeltaPct)}, latency ${pctDisplay(item.latencyDeltaPct)}`,
				),
			]
		: []),
	'',
	'<details>',
	'<summary>Detailed metrics</summary>',
	'',
	'| Task | Ops/sec (mean) | Ops/sec (min) | Ops/sec (max) | ±RME % | Latency mean (ms) | p50 (ms) | p75 (ms) | p99 (ms) | Max (ms) | Runs |',
	'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
	...rows.map((row) =>
		[
			row.name,
			row.opsMean.toLocaleString(),
			row.opsMin.toLocaleString(),
			row.opsMax.toLocaleString(),
			row.opsRmePct.toLocaleString(),
			row.latencyMeanMs.toLocaleString(),
			toDisplay(row.latencyP50Ms),
			toDisplay(row.latencyP75Ms),
			toDisplay(row.latencyP99Ms),
			row.latencyMaxMs.toLocaleString(),
			countDisplay(row.runs),
		]
			.map((cell) => String(cell))
			.join(' | '),
	),
	'',
	'> Ops/sec uses the geometric mean over the measured throughput samples. Latency statistics are in milliseconds.',
	'',
	'</details>',
]

writeFileSync(
	new URL('plugin-lifecycle.md', benchmarksDir),
	markdownLines
		.map((line) => {
			if (
				!line ||
				line.startsWith('#') ||
				line.startsWith('- ') ||
				line.startsWith('>') ||
				line.startsWith('<') ||
				line.startsWith('```')
			) {
				return line
			}
			if (line.startsWith('|')) return line
			return `| ${line} |`
		})
		.join('\n'),
	'utf8',
)

writeFileSync(
	new URL('plugin-lifecycle-diff.json', benchmarksDir),
	JSON.stringify(
		{
			recordedAt,
			baselineRecordedAt,
			tolerancePct,
			comparison,
		},
		null,
		2,
	),
)
