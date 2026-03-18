import '@pluxel/core/services'
import { Bench } from 'tinybench'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

import {
	baselineEnvPath,
	benchOptions,
	debugBench,
	scenarioSizes,
	strictMode,
	tolerancePct,
	writeBaseline,
} from './pluginLifecycle/env'
import { createScenario } from './pluginLifecycle/scenario'
import { registerPluginLifecycleBenchmarks, TASK_MEANING } from './pluginLifecycle/tasks'
import {
	buildComparison,
	collectRows,
	loadBaselineReport,
	printRowsTable,
	renderMarkdown,
	resolveBaselinePath,
	toDiffReport,
	toMainReport,
	writeReports,
} from './pluginLifecycle/report'

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

if (debugBench) console.log('[bench] cwd:', process.cwd())

const bench = new Bench({
	time: benchOptions.timeMs,
	warmupTime: benchOptions.warmupTimeMs,
	warmupIterations: benchOptions.warmupIterations,
	iterations: Number.isFinite(benchOptions.iterations) ? benchOptions.iterations : undefined,
})

const scenario = createScenario(scenarioSizes)
const disposeStableContexts = registerPluginLifecycleBenchmarks(bench, scenario)

const restore = silencePluginLogs()
await bench.run()
restore()

const recordedAt = new Date().toISOString()
const runtime = { name: bench.runtime, version: bench.runtimeVersion }

const rows = collectRows(bench)
printRowsTable(rows)

const benchmarksDir = new URL('../benchmarks/', import.meta.url)
mkdirSync(fileURLToPath(benchmarksDir), { recursive: true })

const defaultBaselinePath = fileURLToPath(new URL('plugin-lifecycle.baseline.json', benchmarksDir))
const resolvedBaselinePath = baselineEnvPath
	? (resolveBaselinePath(baselineEnvPath) ?? fileURLToPath(new URL(baselineEnvPath, benchmarksDir)))
	: defaultBaselinePath
if (debugBench && baselineEnvPath) {
	console.log('[bench] baseline candidates resolved to:', resolvedBaselinePath ?? '(not found)')
}

const baselineReport = resolvedBaselinePath ? loadBaselineReport(resolvedBaselinePath) : null
const comparison = buildComparison(rows, baselineReport)

const mainReport = toMainReport({
	recordedAt,
	runtime,
	options: {
		scenario: scenario.sizes,
		timeMs: benchOptions.timeMs,
		warmupTimeMs: benchOptions.warmupTimeMs,
		warmupIterations: benchOptions.warmupIterations,
		minIterations: Number.isFinite(benchOptions.iterations) ? benchOptions.iterations : null,
	},
	tasks: rows,
	comparison,
	baselineRecordedAt: baselineReport?.recordedAt ?? null,
})

const markdown = renderMarkdown({
	report: mainReport,
	taskMeaning: TASK_MEANING,
	regressionTolerancePct: tolerancePct,
})

const diff = toDiffReport({
	recordedAt,
	baselineRecordedAt: baselineReport?.recordedAt ?? null,
	tolerancePct,
	comparison,
})

writeReports({
	benchmarksDir,
	mainReport,
	markdown,
	diffReport: diff,
	writeBaseline,
	baselinePath: new URL('plugin-lifecycle.baseline.json', benchmarksDir),
})

if (comparison.length) {
	console.log('\nComparison vs baseline:')
	console.table(
		comparison.map((item) => ({
			Task: item.name,
			Status: item.status,
			'Ops Δ%':
				item.opsDeltaPct == null
					? '—'
					: `${item.opsDeltaPct > 0 ? '+' : ''}${item.opsDeltaPct.toFixed(2)}%`,
			'Latency Δ%':
				item.latencyDeltaPct == null
					? '—'
					: `${item.latencyDeltaPct > 0 ? '+' : ''}${item.latencyDeltaPct.toFixed(2)}%`,
			'Baseline ops': item.baselineOpsMean ?? '—',
			'Current ops': item.opsMean ?? '—',
			'Baseline latency (ms)': item.baselineLatencyMeanMs ?? '—',
			'Current latency (ms)': item.latencyMeanMs ?? '—',
		})),
	)
}

const regressions = comparison
	.filter((item) => item.status === 'measured')
	.filter((item) => {
		const opsDelta = item.opsDeltaPct ?? 0
		const latencyDelta = item.latencyDeltaPct ?? 0
		return opsDelta < -tolerancePct || latencyDelta > tolerancePct
	})

if (regressions.length) {
	console.warn('\nPotential regressions detected (threshold:', tolerancePct, '%):')
	for (const item of regressions) {
		console.warn(
			`- ${item.name}: ops Δ ${item.opsDeltaPct?.toFixed(2) ?? '—'}%, latency Δ ${item.latencyDeltaPct?.toFixed(2) ?? '—'}%`,
		)
	}
	if (strictMode) {
		console.error(
			'[bench] Failing build due to regressions exceeding tolerance. Set PLUXEL_BENCH_STRICT=0 to disable.',
		)
		process.exitCode = 1
	}
}

disposeStableContexts()
