import '@pluxel/core/services'
import { Bench } from 'tinybench'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'

import {
	benchOptions,
	debugBench,
	outputDirEnvPath,
	referenceEnvPath,
	selectedTaskNames,
	scenarioSizes,
	strictMode,
	tolerancePct,
	verboseBench,
} from './pluginLifecycle/env.ts'
import { TASK_METADATA, WORKLOAD_ID, type TaskMetadata } from './pluginLifecycle/catalog.ts'
import { createScenario } from './pluginLifecycle/scenario.ts'
import { registerPluginLifecycleBenchmarks } from './pluginLifecycle/tasks.ts'
import {
	assessReferenceCompatibility,
	buildComparison,
	collectRows,
	loadReferenceReport,
	printRowsTable,
	renderMarkdown,
	resolveReferencePath,
	selectReferenceTasks,
	isLatencyRegression,
	toMainReport,
	writeReports,
} from './pluginLifecycle/report.ts'

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
		while (restoreStack.length > 0) {
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
const taskMetadata: Record<string, TaskMetadata> = TASK_METADATA

const restore = silencePluginLogs()
const disposeBenchContexts = registerPluginLifecycleBenchmarks(bench, scenario)
const selectedTasks = new Set<string>(selectedTaskNames)
for (const task of bench.tasks.slice()) {
	if (!selectedTasks.has(task.name)) bench.remove(task.name)
}
try {
	await bench.run()
} finally {
	restore()
	disposeBenchContexts()
}

const recordedAt = new Date().toISOString()
const runtime = { name: bench.runtime, version: bench.runtimeVersion }

const rows = collectRows(bench)
printRowsTable(rows, { detailed: verboseBench })

const benchmarksDir = outputDirEnvPath
	? pathToFileURL(`${path.resolve(outputDirEnvPath)}${path.sep}`)
	: new URL('../benchmarks/', import.meta.url)
mkdirSync(fileURLToPath(benchmarksDir), { recursive: true })

const resolvedReferencePath = referenceEnvPath
	? (resolveReferencePath(referenceEnvPath) ??
		fileURLToPath(new URL(referenceEnvPath, benchmarksDir)))
	: null
if (debugBench && referenceEnvPath) {
	console.log('[bench] reference report resolved to:', resolvedReferencePath ?? '(not found)')
}

const referenceCompatibility = assessReferenceCompatibility(
	loadReferenceReport(resolvedReferencePath),
	{
		id: WORKLOAD_ID,
		scenario: scenario.sizes,
	},
)
const referenceReport = selectReferenceTasks(referenceCompatibility.report, selectedTaskNames)
const comparison = buildComparison(rows, referenceReport)

const mainReport = toMainReport({
	recordedAt,
	runtime,
	workloadId: WORKLOAD_ID,
	options: {
		scenario: scenario.sizes,
		selectedTasks: selectedTaskNames,
		timeMs: benchOptions.timeMs,
		warmupTimeMs: benchOptions.warmupTimeMs,
		warmupIterations: benchOptions.warmupIterations,
		minIterations: Number.isFinite(benchOptions.iterations) ? benchOptions.iterations : null,
	},
	taskMetadata,
	tasks: rows,
	comparison,
	referenceCompatibility,
})

const markdown = renderMarkdown({
	report: mainReport,
	taskMetadata,
	regressionTolerancePct: tolerancePct,
})

writeReports({
	benchmarksDir,
	mainReport,
	markdown,
})

const measuredComparison = comparison.filter((item) => item.status === 'measured')
if (measuredComparison.length > 0 && verboseBench) {
	console.log('\nComparison vs reference:')
	console.table(
		measuredComparison.map((item) => ({
			Task: item.name,
			'Ops Δ':
				item.opsDeltaPct == null
					? '—'
					: `${item.opsDeltaPct > 0 ? '+' : ''}${item.opsDeltaPct.toFixed(2)}%`,
			'Lat Δ':
				item.latencyDeltaPct == null
					? '—'
					: `${item.latencyDeltaPct > 0 ? '+' : ''}${item.latencyDeltaPct.toFixed(2)}%`,
			'Ref ops': item.referenceOpsMean ?? '—',
			'Now ops': item.opsMean ?? '—',
			'Ref ms': item.referenceLatencyMeanMs ?? '—',
			'Now ms': item.latencyMeanMs ?? '—',
		})),
	)
}

const regressions = comparison.filter((item) =>
	isLatencyRegression(item, tolerancePct, taskMetadata[item.name]),
)

if (regressions.length > 0) {
	console.warn(`\nLatency regressions (>${tolerancePct}%):`)
	for (const item of regressions) {
		console.warn(`- ${item.name}: latency Δ ${item.latencyDeltaPct?.toFixed(2) ?? '—'}%`)
	}
	if (strictMode) {
		console.error('[bench] Strict mode: latency regression.')
		process.exitCode = 1
	}
}
