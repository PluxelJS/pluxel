import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
	Bench,
	TaskResult,
	TaskResultRuntimeInfo,
	TaskResultTimestampProviderInfo,
	TaskResultWithStatistics,
} from 'tinybench'

type CompletedResult = TaskResultWithStatistics &
	TaskResultRuntimeInfo &
	TaskResultTimestampProviderInfo
const assertCompleted = (
	taskName: string,
	result: TaskResult & TaskResultRuntimeInfo & TaskResultTimestampProviderInfo,
): CompletedResult => {
	if (result.state !== 'completed') {
		throw new Error(`Benchmark task "${taskName}" did not complete (state: ${result.state})`)
	}
	return result
}

const round = (value: number, digits = 3) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : value
const pct = (value: number, digits = 2) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : value
const safe = (value: number | undefined | null, digits = 3) =>
	value == null ? null : round(value, digits)

const ratioPct = (current: number, baseline: number) =>
	baseline === 0 ? null : ((current - baseline) / baseline) * 100

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
	if (deltaText && deltaText !== '—') parts.push(`Δ ${deltaText}`)
	if (baseline != null && !Number.isNaN(baseline)) parts.push(`base ${baseline.toLocaleString()}`)
	return parts.join(' · ')
}

export type BenchRow = {
	name: string
	runs: number | null
	totalTimeMs: number
	opsMean: number
	opsMin: number
	opsMax: number
	opsRmePct: number
	latencyMeanMs: number
	latencyP50Ms: number | null
	latencyP75Ms: number | null
	latencyP99Ms: number | null
	latencyMaxMs: number
	latencyRmePct: number
	latencySdMs: number
}

export function collectRows(bench: Bench): BenchRow[] {
	return bench.tasks.map((task) => {
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
}

export function printRowsTable(rows: BenchRow[]) {
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
}

export type ComparisonRow = {
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

export type BaselineReport = { tasks: BenchRow[]; recordedAt?: string }

export const resolveBaselinePath = (input: string): string | null => {
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

export function loadBaselineReport(baselinePath: string): BaselineReport | null {
	if (!existsSync(baselinePath)) return null
	try {
		const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
		if (Array.isArray(parsed?.tasks)) {
			return {
				tasks: parsed.tasks as BenchRow[],
				recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : undefined,
			}
		}
	} catch (err) {
		console.warn('[bench] Failed to parse baseline JSON:', err)
	}
	return null
}

export function buildComparison(
	rows: BenchRow[],
	baselineReport: BaselineReport | null,
): ComparisonRow[] {
	const baselineByName = new Map<string, BenchRow>()
	for (const row of baselineReport?.tasks ?? []) baselineByName.set(row.name, row)

	const comparison: ComparisonRow[] = rows.map((row) => {
		const base = baselineByName.get(row.name)
		const baselineOpsMean = base?.opsMean ?? null
		const baselineLatencyMeanMs = base?.latencyMeanMs ?? null
		const opsMean = row.opsMean ?? null
		const latencyMeanMs = row.latencyMeanMs ?? null

		const opsDelta =
			opsMean != null && baselineOpsMean != null ? ratioPct(opsMean, baselineOpsMean) : null
		const latencyDelta =
			latencyMeanMs != null && baselineLatencyMeanMs != null
				? ratioPct(latencyMeanMs, baselineLatencyMeanMs)
				: null

		return {
			name: row.name,
			baselineOpsMean,
			baselineLatencyMeanMs,
			opsMean,
			latencyMeanMs,
			opsDeltaPct: opsDelta != null ? pct(opsDelta) : null,
			latencyDeltaPct: latencyDelta != null ? pct(latencyDelta) : null,
			runs: row.runs,
			status: base ? 'measured' : 'new',
		}
	})

	for (const base of baselineReport?.tasks ?? []) {
		if (!rows.find((row) => row.name === base.name)) {
			comparison.push({
				name: base.name,
				baselineOpsMean: base.opsMean ?? null,
				baselineLatencyMeanMs: base.latencyMeanMs ?? null,
				opsMean: null,
				latencyMeanMs: null,
				opsDeltaPct: null,
				latencyDeltaPct: null,
				runs: null,
				status: 'missing',
			})
		}
	}

	return comparison
}

export type RuntimeInfo = { name: string; version: string }

export type MainReport = {
	recordedAt: string
	runtime: RuntimeInfo
	options: {
		scenario: Record<string, unknown>
		timeMs: number
		warmupTimeMs: number
		warmupIterations: number
		minIterations: number | null
	}
	tasks: BenchRow[]
	keyMetrics: Array<{
		name: string
		throughputOpsPerSecond: number
		throughputMarginOfErrorPct: number
		latencyMeanMs: number
		latencyP99Ms: number | null
		runs: number | null
	}>
	comparison?: Array<{
		name: string
		baselineOpsMean: number | null
		opsMean: number | null
		opsDeltaPct: number | null
		baselineLatencyMeanMs: number | null
		latencyMeanMs: number | null
		latencyDeltaPct: number | null
		runs: number | null
		status: 'measured' | 'new' | 'missing'
	}>
	baseline?: { recordedAt: string | null }
}

export function toMainReport(input: {
	recordedAt: string
	runtime: RuntimeInfo
	options: MainReport['options']
	tasks: BenchRow[]
	comparison: ComparisonRow[]
	baselineRecordedAt: string | null
}): MainReport {
	return {
		recordedAt: input.recordedAt,
		runtime: input.runtime,
		options: input.options,
		tasks: input.tasks,
		keyMetrics: input.tasks.map((row) => ({
			name: row.name,
			throughputOpsPerSecond: row.opsMean,
			throughputMarginOfErrorPct: row.opsRmePct,
			latencyMeanMs: row.latencyMeanMs,
			latencyP99Ms: row.latencyP99Ms,
			runs: row.runs,
		})),
		comparison: input.comparison.length
			? input.comparison.map((item) => ({
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
		baseline:
			input.baselineRecordedAt != null ? { recordedAt: input.baselineRecordedAt } : undefined,
	}
}

export type DiffReport = {
	recordedAt: string
	baselineRecordedAt: string | null
	tolerancePct: number
	comparison: ComparisonRow[]
}

export function toDiffReport(input: DiffReport): DiffReport {
	return input
}

const statusLabel = (status: ComparisonRow['status']) => {
	switch (status) {
		case 'measured':
			return '✅ tracked'
		case 'new':
			return '🆕 new'
		case 'missing':
			return '⚠️ missing'
	}
}

export function renderMarkdown(input: {
	report: MainReport
	taskMeaning: Record<string, { goal: string; area: string }>
	regressionTolerancePct: number
}) {
	const { report, taskMeaning, regressionTolerancePct } = input
	const comparison = report.comparison ?? []

	const regressions = comparison.filter((item) => {
		if (item.status !== 'measured') return false
		const opsDelta = item.opsDeltaPct ?? 0
		const latencyDelta = item.latencyDeltaPct ?? 0
		return opsDelta < -regressionTolerancePct || latencyDelta > regressionTolerancePct
	})

	const lines: string[] = [
		'# Plugin lifecycle benchmark',
		'',
		`- Recorded at: ${report.recordedAt}`,
		`- Runtime: ${report.runtime.name} ${report.runtime.version}`,
		`- Target benchmark time: ${report.options.timeMs}ms (warmup ${report.options.warmupTimeMs}ms)`,
		`- Baseline: ${report.baseline?.recordedAt ?? 'not available'}`,
		`- Regression tolerance: ±${regressionTolerancePct}%`,
		'',
		'## Top latency (mean)',
		'',
		'| Task | Area | Latency mean (ms) |',
		'| --- | --- | ---: |',
		...report.tasks
			.slice()
			.sort((a, b) => (b.latencyMeanMs ?? 0) - (a.latencyMeanMs ?? 0))
			.slice(0, 8)
			.map((row) => {
				const area = taskMeaning[row.name]?.area ?? 'unknown'
				return `| ${row.name} | ${area} | ${row.latencyMeanMs.toLocaleString()} |`
			}),
		'',
		'## Summary',
		'',
		'| Task | Ops/sec | Latency mean (ms) | Status | Runs |',
		'| --- | --- | --- | --- | ---: |',
		...comparison.map(
			(item) =>
				`| ${item.name} | ${metricSummary(item.opsMean, item.opsDeltaPct, item.baselineOpsMean)} | ${metricSummary(
					item.latencyMeanMs,
					item.latencyDeltaPct,
					item.baselineLatencyMeanMs,
				)} | ${statusLabel(item.status)} | ${item.runs != null ? item.runs.toLocaleString() : '—'} |`,
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
		...report.tasks.map(
			(row) =>
				`| ${row.name} | ${row.opsMean.toLocaleString()} | ${row.opsMin.toLocaleString()} | ${row.opsMax.toLocaleString()} | ${row.opsRmePct.toLocaleString()} | ${row.latencyMeanMs.toLocaleString()} | ${toDisplay(row.latencyP50Ms)} | ${toDisplay(row.latencyP75Ms)} | ${toDisplay(row.latencyP99Ms)} | ${row.latencyMaxMs.toLocaleString()} | ${countDisplay(row.runs)} |`,
		),
		'',
		'> Ops/sec uses the geometric mean over the measured throughput samples. Latency statistics are in milliseconds.',
		'> "Area" is a coarse attribution hint for quickly spotting which subsystem is slow (build/verify, dependents traversal, lifecycle, config injection).',
		'',
		'</details>',
		'',
		// Keep "meaning"/intent last: humans care about numbers first; LLMs can read the rest.
		'## Scenario',
		'',
		'```json',
		JSON.stringify(report.options.scenario, null, 2),
		'```',
		'',
		'## Task meanings',
		'',
		'| Task | Area | Goal |',
		'| --- | --- | --- |',
		...report.tasks.map((row) => {
			const meaning = taskMeaning[row.name]
			const area = meaning?.area ?? 'unknown'
			const goal = meaning?.goal ?? '(no description)'
			return `| ${row.name} | ${area} | ${goal} |`
		}),
	]

	return `${lines.join('\n')}\n`
}

export function writeReports(input: {
	benchmarksDir: URL
	mainReport: MainReport
	markdown: string
	diffReport: DiffReport
	writeBaseline: boolean
	baselinePath: URL
}) {
	writeFileSync(
		new URL('plugin-lifecycle.json', input.benchmarksDir),
		JSON.stringify(input.mainReport, null, 2),
	)
	writeFileSync(new URL('plugin-lifecycle.md', input.benchmarksDir), input.markdown, 'utf8')
	writeFileSync(
		new URL('plugin-lifecycle-diff.json', input.benchmarksDir),
		JSON.stringify(input.diffReport, null, 2),
	)

	if (input.writeBaseline) {
		const baseline = {
			recordedAt: input.mainReport.recordedAt,
			runtime: input.mainReport.runtime,
			options: input.mainReport.options,
			tasks: input.mainReport.tasks,
		}
		writeFileSync(input.baselinePath, JSON.stringify(baseline, null, 2))
	}
}

export const toDiffReportFilePath = (benchmarksDir: URL) =>
	fileURLToPath(new URL('plugin-lifecycle-diff.json', benchmarksDir))
