import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bench } from 'tinybench'

import { Context } from '../context'
import { PluginA, PluginB, PluginC } from '../plugins'

type CommitResult = Awaited<ReturnType<Context['registry']['commit']>>

const numberFromEnv = (key: string, fallback: number) => {
	const raw = process.env[key]
	if (raw == null) return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : fallback
}

const bench = new Bench({
	time: numberFromEnv('PLUXEL_BENCH_TIME', 350),
	warmupTime: numberFromEnv('PLUXEL_BENCH_WARMUP_TIME', 150),
	warmupIterations: numberFromEnv('PLUXEL_BENCH_WARMUP_ITERATIONS', 24),
})

const tolerancePct = numberFromEnv('PLUXEL_BENCH_TOLERANCE', 5)
const strictMode = process.env.PLUXEL_BENCH_STRICT === '1'

if (process.env.DEBUG_BENCH === '1') {
	console.log('[bench] cwd:', process.cwd())
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
	const result = task.result
	if (!result) {
		throw new Error(`Benchmark task "${task.name}" has no result.`)
	}
	const { latency, throughput } = result
	return {
		name: task.name,
		runs: latency.samples.length,
		totalTimeMs: round(result.totalTime),
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
	opsMean: number
	latencyMeanMs: number
	opsDeltaPct: number | null
	latencyDeltaPct: number | null
	status: 'measured' | 'new'
}

const baselineEnvPath = process.env.PLUXEL_BENCH_BASELINE
let baselineReport: {
	tasks?: BenchRow[]
	recordedAt?: string
} | null = null

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
			baselineReport = parsed
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

const comparison: ComparisonRow[] = []
if (baselineReport?.tasks) {
	const baselineIndex = new Map<string, BenchRow>()
	for (const task of baselineReport.tasks) {
		baselineIndex.set(task.name, task as BenchRow)
	}
	for (const row of rows) {
		const baseline = baselineIndex.get(row.name)
		if (!baseline) {
			comparison.push({
				name: row.name,
				baselineOpsMean: null,
				baselineLatencyMeanMs: null,
				opsMean: row.opsMean,
				latencyMeanMs: row.latencyMeanMs,
				opsDeltaPct: null,
				latencyDeltaPct: null,
				status: 'new',
			})
			continue
		}
		comparison.push({
			name: row.name,
			baselineOpsMean: baseline.opsMean ?? null,
			baselineLatencyMeanMs: baseline.latencyMeanMs ?? null,
			opsMean: row.opsMean,
			latencyMeanMs: row.latencyMeanMs,
			opsDeltaPct:
				baseline.opsMean != null
					? pct(ratioPct(row.opsMean, baseline.opsMean) ?? Number.NaN)
					: null,
			latencyDeltaPct:
				baseline.latencyMeanMs != null
					? pct(ratioPct(row.latencyMeanMs, baseline.latencyMeanMs) ?? Number.NaN)
					: null,
			status: 'measured',
		})
	}

	if (comparison.length) {
		console.log('\nComparison vs baseline:')
		console.table(
			comparison.map((item) => ({
				Task: item.name,
				'Ops Δ%': pctDisplay(item.opsDeltaPct),
				'Latency Δ%': pctDisplay(item.latencyDeltaPct),
				'Baseline ops': item.baselineOpsMean ? item.baselineOpsMean.toLocaleString() : '—',
				'Current ops': item.opsMean.toLocaleString(),
				'Baseline latency (ms)': item.baselineLatencyMeanMs
					? item.baselineLatencyMeanMs.toLocaleString()
					: '—',
				'Current latency (ms)': item.latencyMeanMs.toLocaleString(),
			})),
		)
	}

	const regressions = comparison.filter((item) => {
		if (item.status === 'new') return false
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
}

const report = {
	recordedAt,
	runtime,
	options: {
		timeMs: bench.opts.time,
		warmupTimeMs: bench.opts.warmupTime,
		warmupIterations: bench.opts.warmupIterations,
		minIterations: bench.opts.iterations,
	},
	tasks: rows,
	comparison: comparison.length
		? comparison.map((item) => ({
				name: item.name,
				baselineOpsMean: item.baselineOpsMean,
				opsMean: item.opsMean,
				opsDeltaPct: item.opsDeltaPct,
				baselineLatencyMeanMs: item.baselineLatencyMeanMs,
				latencyMeanMs: item.latencyMeanMs,
				latencyDeltaPct: item.latencyDeltaPct,
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

const markdownLines = [
	'# Plugin lifecycle benchmark',
	'',
	`- Recorded at: ${recordedAt}`,
	`- Runtime: ${runtime.name} ${runtime.version}`,
	`- Target benchmark time: ${bench.opts.time}ms (warmup ${bench.opts.warmupTime}ms)`,
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
			row.runs.toLocaleString(),
		]
			.map((cell) => String(cell))
			.join(' | '),
	),
	'',
	'> Ops/sec uses the geometric mean over the measured throughput samples. Latency statistics are in milliseconds.',
]

if (comparison.length) {
	markdownLines.push('', '## Comparison vs baseline')
	if (baselineReport?.recordedAt) {
		markdownLines.push(`- Baseline recorded at: ${baselineReport.recordedAt}`)
	}
	markdownLines.push(
		'| Task | Δ Ops/sec | Δ Latency mean | Baseline Ops/sec | Current Ops/sec | Baseline Latency (ms) | Current Latency (ms) |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
	)
	for (const item of comparison) {
		markdownLines.push(
			[
				item.name,
				pctDisplay(item.opsDeltaPct),
				pctDisplay(item.latencyDeltaPct),
				item.baselineOpsMean != null ? item.baselineOpsMean.toLocaleString() : '—',
				item.opsMean.toLocaleString(),
				item.baselineLatencyMeanMs != null ? item.baselineLatencyMeanMs.toLocaleString() : '—',
				item.latencyMeanMs.toLocaleString(),
			]
				.map((cell) => String(cell))
				.join(' | '),
		)
	}
}

writeFileSync(
	new URL('plugin-lifecycle.md', benchmarksDir),
	markdownLines
		.map((line) => {
			if (!line || line.startsWith('#') || line.startsWith('- ') || line.startsWith('>')) {
				return line
			}
			if (line.startsWith('|')) return line
			return `| ${line} |`
		})
		.join('\n'),
	'utf8',
)

if (comparison.length) {
	writeFileSync(
		new URL('plugin-lifecycle-diff.json', benchmarksDir),
		JSON.stringify(
			{
				recordedAt,
				baselineRecordedAt: baselineReport?.recordedAt ?? null,
				tolerancePct,
				comparison,
			},
			null,
			2,
		),
	)
}
