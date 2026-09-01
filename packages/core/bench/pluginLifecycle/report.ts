import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DECISION_SIGNALS, type TaskMetadata } from './catalog.ts'
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

type TaskResultWithRuntime = TaskResult & TaskResultRuntimeInfo & TaskResultTimestampProviderInfo

const assertCompleted = (taskName: string, result: TaskResultWithRuntime): CompletedResult => {
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
const ratioPct = (current: number, reference: number) =>
	reference === 0 ? null : ((current - reference) / reference) * 100
const display = (value: number | null | undefined) =>
	value == null || Number.isNaN(value) ? '—' : value.toLocaleString()
const pctDisplay = (value: number | null | undefined) =>
	value == null || Number.isNaN(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const ratioDisplay = (value: number | null | undefined) =>
	value == null || Number.isNaN(value) ? '—' : `${value.toLocaleString()}x`

export type BenchRow = {
	name: string
	runs: number | null
	opsMean: number
	opsRmePct: number
	latencyMeanMs: number
	latencyP99Ms: number | null
	latencyRmePct: number
}

const noisyLatencyRmePct = 10
const minRegressionDeltaMs = 0.01

const noisyLatencyRows = (rows: BenchRow[]) =>
	rows
		.filter((row) => row.latencyRmePct > noisyLatencyRmePct)
		.sort((a, b) => b.latencyRmePct - a.latencyRmePct)

export function collectRows(bench: Bench): BenchRow[] {
	return bench.tasks.map((task) => {
		const result = assertCompleted(task.name, task.result)
		const { latency, throughput } = result
		const runs =
			latency.samplesCount ??
			throughput.samplesCount ??
			(Number.isFinite(task.runs) ? task.runs : undefined)

		return {
			name: task.name,
			runs: runs ?? null,
			opsMean: round(throughput.mean),
			opsRmePct: pct(throughput.rme),
			latencyMeanMs: round(latency.mean),
			latencyP99Ms: safe(latency.p99),
			latencyRmePct: pct(latency.rme),
		}
	})
}

export function printRowsTable(rows: BenchRow[], options: { detailed?: boolean } = {}) {
	const shown = options.detailed
		? rows
		: rows
				.slice()
				.sort((a, b) => b.latencyMeanMs - a.latencyMeanMs)
				.slice(0, 8)

	console.log('')
	console.table(
		shown.map((row) => ({
			Task: row.name,
			'Mean ms': row.latencyMeanMs,
			'p99 ms': display(row.latencyP99Ms),
			'RME %': row.latencyRmePct,
			'Ops/s': row.opsMean,
			Runs: row.runs,
		})),
	)

	const noisy = noisyLatencyRows(rows)
	if (noisy.length > 0) {
		console.warn(
			`[bench] ${noisy.length} noisy task(s); increase PLUXEL_BENCH_TIME before optimizing.`,
		)
	}
}

export type ReferenceReport = {
	recordedAt?: string
	workload?: { id: string }
	scenario?: Record<string, unknown>
	provenance?: { method: string; description?: string }
	tasks: BenchRow[]
}

export type WorkloadDescriptor = Readonly<{
	id: string
	scenario: Readonly<Record<string, unknown>>
}>

export type ReferenceCompatibility = Readonly<{
	status: 'none' | 'compatible' | 'incompatible'
	reason: string | null
	recordedAt: string | null
	provenance: ReferenceReport['provenance'] | null
	report: ReferenceReport | null
}>

export const resolveReferencePath = (input: string): string | null => {
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

export function loadReferenceReport(
	referencePath: string | null | undefined,
): ReferenceReport | null {
	if (!referencePath || !existsSync(referencePath)) return null
	try {
		const parsed = JSON.parse(readFileSync(referencePath, 'utf8'))
		if (!Array.isArray(parsed?.tasks)) return null
		const workloadId =
			typeof parsed.workload?.id === 'string' && parsed.workload.id.length > 0
				? parsed.workload.id
				: undefined
		const scenario =
			parsed.options?.scenario &&
			typeof parsed.options.scenario === 'object' &&
			!Array.isArray(parsed.options.scenario)
				? (parsed.options.scenario as Record<string, unknown>)
				: undefined
		const provenance =
			typeof parsed.provenance?.method === 'string'
				? {
						method: parsed.provenance.method,
						...(typeof parsed.provenance.description === 'string'
							? { description: parsed.provenance.description }
							: {}),
					}
				: undefined
		return {
			recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : undefined,
			...(workloadId === undefined ? {} : { workload: { id: workloadId } }),
			...(scenario === undefined ? {} : { scenario }),
			...(provenance === undefined ? {} : { provenance }),
			tasks: parsed.tasks as BenchRow[],
		}
	} catch (err) {
		console.warn('[bench] Failed to parse reference report:', err)
		return null
	}
}

const scenariosEqual = (
	left: Readonly<Record<string, unknown>>,
	right: Readonly<Record<string, unknown>>,
) => {
	const leftKeys = Object.keys(left).sort()
	const rightKeys = Object.keys(right).sort()
	if (leftKeys.length !== rightKeys.length) return false
	for (let i = 0; i < leftKeys.length; i++) {
		const key = leftKeys[i]!
		if (key !== rightKeys[i] || !Object.is(left[key], right[key])) return false
	}
	return true
}

export function assessReferenceCompatibility(
	report: ReferenceReport | null,
	workload: WorkloadDescriptor,
): ReferenceCompatibility {
	if (!report) {
		return {
			status: 'none',
			reason: 'no reference report',
			recordedAt: null,
			provenance: null,
			report: null,
		}
	}
	const recordedAt = report.recordedAt ?? null
	const provenance = report.provenance ?? null
	if (!report.workload) {
		return {
			status: 'incompatible',
			reason: 'reference workload identity is missing',
			recordedAt,
			provenance,
			report: null,
		}
	}
	if (report.workload.id !== workload.id) {
		return {
			status: 'incompatible',
			reason: `workload id differs (${report.workload.id} != ${workload.id})`,
			recordedAt,
			provenance,
			report: null,
		}
	}
	if (!report.scenario) {
		return {
			status: 'incompatible',
			reason: 'reference scenario is missing',
			recordedAt,
			provenance,
			report: null,
		}
	}
	if (!scenariosEqual(report.scenario, workload.scenario)) {
		return {
			status: 'incompatible',
			reason: 'scenario differs',
			recordedAt,
			provenance,
			report: null,
		}
	}
	return { status: 'compatible', reason: null, recordedAt, provenance, report }
}

export function selectReferenceTasks(
	report: ReferenceReport | null,
	selectedTasks: readonly string[],
): ReferenceReport | null {
	if (!report) return null
	const selected = new Set(selectedTasks)
	return { ...report, tasks: report.tasks.filter((task) => selected.has(task.name)) }
}

export type ComparisonRow = {
	name: string
	referenceOpsMean: number | null
	referenceLatencyMeanMs: number | null
	referenceLatencyRmePct: number | null
	opsMean: number | null
	latencyMeanMs: number | null
	opsDeltaPct: number | null
	latencyDeltaPct: number | null
	runs: number | null
	reliable: boolean
	status: 'measured' | 'new' | 'missing'
}

export function buildComparison(rows: BenchRow[], referenceReport: ReferenceReport | null) {
	const referenceByName = new Map<string, BenchRow>()
	for (const row of referenceReport?.tasks ?? []) referenceByName.set(row.name, row)

	const comparison: ComparisonRow[] = rows.map((row) => {
		const reference = referenceByName.get(row.name)
		const referenceOpsMean = reference?.opsMean ?? null
		const referenceLatencyMeanMs = reference?.latencyMeanMs ?? null
		const referenceLatencyRmePct = reference?.latencyRmePct ?? null
		const opsDelta = referenceOpsMean == null ? null : ratioPct(row.opsMean, referenceOpsMean)
		const latencyDelta =
			referenceLatencyMeanMs == null ? null : ratioPct(row.latencyMeanMs, referenceLatencyMeanMs)
		const referenceReliable =
			referenceLatencyRmePct != null && referenceLatencyRmePct <= noisyLatencyRmePct

		return {
			name: row.name,
			referenceOpsMean,
			referenceLatencyMeanMs,
			referenceLatencyRmePct,
			opsMean: row.opsMean,
			latencyMeanMs: row.latencyMeanMs,
			opsDeltaPct: opsDelta == null ? null : pct(opsDelta),
			latencyDeltaPct: latencyDelta == null ? null : pct(latencyDelta),
			runs: row.runs,
			reliable: row.latencyRmePct <= noisyLatencyRmePct && referenceReliable,
			status: reference ? 'measured' : 'new',
		}
	})

	for (const reference of referenceReport?.tasks ?? []) {
		if (rows.some((row) => row.name === reference.name)) continue
		comparison.push({
			name: reference.name,
			referenceOpsMean: reference.opsMean ?? null,
			referenceLatencyMeanMs: reference.latencyMeanMs ?? null,
			referenceLatencyRmePct: reference.latencyRmePct ?? null,
			opsMean: null,
			latencyMeanMs: null,
			opsDeltaPct: null,
			latencyDeltaPct: null,
			runs: null,
			reliable: false,
			status: 'missing',
		})
	}

	return comparison
}

export type DecisionSignal = {
	name: string
	current: number | null
	reference: number | null
	deltaPct: number | null
	numeratorDeltaPct: number | null
	denominatorDeltaPct: number | null
	reliable: boolean
	status: 'watch' | 'ok' | 'missing'
	focus: string
}

const byName = (rows: BenchRow[]) => new Map(rows.map((row) => [row.name, row] as const))

const latencyOf = (rowsByName: Map<string, BenchRow>, name: string) =>
	rowsByName.get(name)?.latencyMeanMs ?? null

const ratioOf = (rowsByName: Map<string, BenchRow>, numerator: string, denominator: string) => {
	const top = latencyOf(rowsByName, numerator)
	const bottom = latencyOf(rowsByName, denominator)
	if (top == null || bottom == null || bottom === 0) return null
	return round(top / bottom, 2)
}

const referenceRowsFromComparison = (comparison: ComparisonRow[]): BenchRow[] =>
	comparison
		.filter((row) => row.referenceLatencyMeanMs != null)
		.map((row): BenchRow => ({
			name: row.name,
			runs: null,
			opsMean: row.referenceOpsMean ?? 0,
			opsRmePct: 0,
			latencyMeanMs: row.referenceLatencyMeanMs!,
			latencyP99Ms: null,
			latencyRmePct: 0,
		}))

export function buildDecisionSignals(rows: BenchRow[], comparison: ComparisonRow[]) {
	const referenceRows = referenceRowsFromComparison(comparison)
	const rowsByName = byName(rows)
	const referenceRowsByName = byName(referenceRows)
	const comparisonByName = new Map(comparison.map((row) => [row.name, row] as const))

	return DECISION_SIGNALS.map((signal): DecisionSignal => {
		const current = ratioOf(rowsByName, signal.numerator, signal.denominator)
		const reference = ratioOf(referenceRowsByName, signal.numerator, signal.denominator)
		const numerator = comparisonByName.get(signal.numerator)
		const denominator = comparisonByName.get(signal.denominator)
		const deltaPct =
			current != null && reference != null ? pct(ratioPct(current, reference) ?? Number.NaN) : null
		return {
			name: signal.name,
			current,
			reference,
			deltaPct,
			numeratorDeltaPct: numerator?.latencyDeltaPct ?? null,
			denominatorDeltaPct: denominator?.latencyDeltaPct ?? null,
			reliable: numerator?.reliable === true && denominator?.reliable === true,
			status: current == null ? 'missing' : current >= signal.watchAt ? 'watch' : 'ok',
			focus:
				latencyOf(rowsByName, signal.numerator) == null ||
				latencyOf(rowsByName, signal.denominator) == null
					? 'missing source task data'
					: signal.focus,
		}
	})
}

export type MainReport = {
	recordedAt: string
	runtime: { name: string; version: string }
	workload: { id: string }
	options: {
		scenario: Record<string, unknown>
		selectedTasks: readonly string[]
		timeMs: number
		warmupTimeMs: number
		warmupIterations: number
		minIterations: number | null
	}
	taskMetadata: Record<string, TaskMetadata>
	tasks: BenchRow[]
	decisionSignals: DecisionSignal[]
	comparison: ComparisonRow[]
	reference: {
		status: ReferenceCompatibility['status']
		reason: string | null
		recordedAt: string | null
		provenance: ReferenceReport['provenance'] | null
	}
}

export function toMainReport(input: {
	recordedAt: string
	runtime: MainReport['runtime']
	workloadId: string
	options: MainReport['options']
	taskMetadata: Record<string, TaskMetadata>
	tasks: BenchRow[]
	comparison: ComparisonRow[]
	referenceCompatibility: ReferenceCompatibility
}): MainReport {
	return {
		recordedAt: input.recordedAt,
		runtime: input.runtime,
		workload: { id: input.workloadId },
		options: input.options,
		taskMetadata: input.taskMetadata,
		tasks: input.tasks,
		decisionSignals: buildDecisionSignals(input.tasks, input.comparison),
		comparison: input.comparison,
		reference: {
			status: input.referenceCompatibility.status,
			reason: input.referenceCompatibility.reason,
			recordedAt: input.referenceCompatibility.recordedAt,
			provenance: input.referenceCompatibility.provenance,
		},
	}
}

const regressionScore = (row: ComparisonRow) =>
	row.reliable ? Math.max(0, row.latencyDeltaPct ?? 0) : 0

export const isLatencyRegression = (
	row: ComparisonRow,
	tolerancePct: number,
	metadata?: TaskMetadata,
) =>
	metadata?.regressionGate !== 'diagnostic' &&
	row.status === 'measured' &&
	row.reliable &&
	row.latencyDeltaPct != null &&
	row.latencyDeltaPct > tolerancePct &&
	row.latencyMeanMs != null &&
	row.referenceLatencyMeanMs != null &&
	row.latencyMeanMs - row.referenceLatencyMeanMs >= minRegressionDeltaMs

const metricSummary = (
	current: number | null | undefined,
	delta: number | null | undefined,
	reference: number | null | undefined,
) => {
	if (current == null) return reference == null ? '—' : `— · ref ${reference.toLocaleString()}`
	const parts = [current.toLocaleString()]
	if (delta != null) parts.push(`Δ ${pctDisplay(delta)}`)
	if (reference != null) parts.push(`ref ${reference.toLocaleString()}`)
	return parts.join(' · ')
}

export function renderMarkdown(input: {
	report: MainReport
	taskMetadata: Record<string, TaskMetadata>
	regressionTolerancePct: number
}) {
	const { report, taskMetadata, regressionTolerancePct } = input
	const tracked = report.comparison.filter((row) => row.status === 'measured')
	const gated = tracked.filter((row) => taskMetadata[row.name]?.regressionGate !== 'diagnostic')
	const regressions = gated.filter((row) =>
		isLatencyRegression(row, regressionTolerancePct, taskMetadata[row.name]),
	)
	const regressionRows = regressions.slice().sort((a, b) => regressionScore(b) - regressionScore(a))
	const hotspotRows = report.tasks
		.slice()
		.sort((a, b) => b.latencyMeanMs - a.latencyMeanMs)
		.slice(0, 8)
	const noisyCount = noisyLatencyRows(report.tasks).length
	const taskByName = byName(report.tasks)
	const decisionSignals = report.decisionSignals.filter((signal) => signal.current != null)
	const referenceSummary =
		report.reference.status === 'compatible'
			? `compatible${
					report.reference.provenance ? ` via ${report.reference.provenance.method}` : ''
				}${report.reference.recordedAt ? ` (${report.reference.recordedAt})` : ''}`
			: report.reference.status === 'incompatible'
				? `incompatible (${report.reference.reason ?? 'unknown reason'})`
				: 'none'
	const resultSummary =
		regressions.length > 0
			? `${regressions.length} regression(s)`
			: report.reference.status === 'incompatible'
				? 'baseline reset (incompatible reference)'
				: report.reference.status === 'none'
					? 'baseline pending (no reference)'
					: 'pass'

	const lines = [
		'# Plugin lifecycle benchmark',
		'',
		`Runtime: ${report.runtime.name} ${report.runtime.version} · Time: ${report.options.timeMs}ms · Warmup: ${report.options.warmupTimeMs}ms`,
		`Workload: ${report.workload.id} · Reference: ${referenceSummary}`,
		...(report.reference.provenance?.description
			? [`Reference method: ${report.reference.provenance.description}`]
			: []),
		`Gate: latency > ${regressionTolerancePct}% and +${minRegressionDeltaMs}ms · RME <= ${noisyLatencyRmePct}% · diagnostic tasks excluded`,
		`Result: ${resultSummary} · Compared: ${tracked.length} · Gated: ${gated.length} · New: ${
			report.comparison.filter((row) => row.status === 'new').length
		} · Missing: ${report.comparison.filter((row) => row.status === 'missing').length}`,
		...(noisyCount > 0
			? [`Noise: ${noisyCount} task(s) over ${noisyLatencyRmePct}% RME; directional only.`]
			: []),
		'',
		'## Signals',
		'',
		'Ratio signals describe topology, not the regression gate. A faster denominator can increase a ratio.',
		'',
		...(decisionSignals.length > 0
			? [
					'| Signal | Now | Ref | Ratio Δ | Numerator Δ | Denominator Δ | Quality | State | Focus |',
					'| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
					...decisionSignals.map(
						(signal) =>
							`| ${signal.name} | ${ratioDisplay(signal.current)} | ${ratioDisplay(
								signal.reference,
							)} | ${pctDisplay(signal.deltaPct)} | ${pctDisplay(
								signal.numeratorDeltaPct,
							)} | ${pctDisplay(signal.denominatorDeltaPct)} | ${
								signal.reliable ? 'reliable' : 'directional'
							} | ${signal.status} | ${signal.focus} |`,
					),
				]
			: ['No complete signal pairs for the selected tasks.']),
		'',
		'## Regressions',
		'',
		...(regressionRows.length > 0
			? [
					'| Task | Area | Lat Δ | Now ms | Ref ms |',
					'| --- | --- | ---: | ---: | ---: |',
					...regressionRows.map(
						(row) =>
							`| ${row.name} | ${taskMetadata[row.name]?.area ?? 'unknown'} | ${pctDisplay(
								row.latencyDeltaPct,
							)} | ${display(row.latencyMeanMs)} | ${display(row.referenceLatencyMeanMs)} |`,
					),
				]
			: ['None.']),
		'',
		'## Hotspots',
		'',
		'| Task | Area | Mean ms | p99 ms | Focus |',
		'| --- | --- | ---: | ---: | --- |',
		...hotspotRows.map(
			(row) =>
				`| ${row.name} | ${taskMetadata[row.name]?.area ?? 'unknown'} | ${display(
					row.latencyMeanMs,
				)} | ${display(row.latencyP99Ms)} | ${
					taskMetadata[row.name]?.focus ?? 'inspect slow path'
				} |`,
		),
		'',
		'<details>',
		'<summary>All tasks</summary>',
		'',
		'| Task | Area | Ops/s | Mean ms | p99 | RME % | Runs |',
		'| --- | --- | --- | --- | ---: | ---: | ---: |',
		...report.comparison.map((row) => {
			const current = taskByName.get(row.name)
			return `| ${row.name} | ${taskMetadata[row.name]?.area ?? 'unknown'} | ${metricSummary(
				row.opsMean,
				row.opsDeltaPct,
				row.referenceOpsMean,
			)} | ${metricSummary(
				row.latencyMeanMs,
				row.latencyDeltaPct,
				row.referenceLatencyMeanMs,
			)} | ${display(current?.latencyP99Ms)} | ${display(current?.latencyRmePct)} | ${
				row.runs?.toLocaleString() ?? '—'
			} |`
		}),
		'',
		'Scenario:',
		'',
		'```json',
		JSON.stringify(report.options.scenario, null, 2),
		'```',
		'',
		'</details>',
	]

	return `${lines.join('\n')}\n`
}

export function writeReports(input: {
	benchmarksDir: URL
	mainReport: MainReport
	markdown: string
}) {
	writeFileSync(
		new URL('plugin-lifecycle.json', input.benchmarksDir),
		JSON.stringify(input.mainReport, null, 2),
	)
	writeFileSync(new URL('plugin-lifecycle.md', input.benchmarksDir), input.markdown, 'utf8')
}
