import { TASK, TASK_METADATA, TASK_NAMES, WORKLOAD_ID, selectTaskNames } from './catalog'
import {
	assessReferenceCompatibility,
	buildComparison,
	buildDecisionSignals,
	isLatencyRegression,
	renderMarkdown,
	selectReferenceTasks,
	toMainReport,
	type BenchRow,
	type ReferenceReport,
} from './report'
import { describe, expect, it } from 'vitest'

const row = (name: string, latencyMeanMs: number, latencyRmePct = 1): BenchRow => ({
	name,
	runs: 100,
	opsMean: 1_000 / latencyMeanMs,
	opsRmePct: 1,
	latencyMeanMs,
	latencyP99Ms: latencyMeanMs,
	latencyRmePct,
})

const scenario = { starLeaves: 200, chainLength: 200, bigIndependent: 800 }

const compatibleReference = (overrides: Partial<ReferenceReport> = {}): ReferenceReport => ({
	recordedAt: '2026-08-23T00:00:00.000Z',
	workload: { id: WORKLOAD_ID },
	scenario,
	tasks: [row(TASK.restartRootStar, 4)],
	...overrides,
})

describe('plugin lifecycle benchmark selection', () => {
	it('defaults to every task and preserves catalog order for a filtered selection', () => {
		expect(selectTaskNames(undefined)).toBe(TASK_NAMES)
		expect(
			selectTaskNames(
				` ${TASK.unregisterRootStar}, ${TASK.restartRootStar}, ${TASK.unregisterRootStar} `,
			),
		).toEqual([TASK.restartRootStar, TASK.unregisterRootStar])
	})

	it('rejects unknown task names instead of silently running an empty benchmark', () => {
		expect(() => selectTaskNames(' , ')).toThrow('PLUXEL_BENCH_TASKS did not contain a task name')
		expect(() => selectTaskNames('not a lifecycle task')).toThrow(
			'Unknown PLUXEL_BENCH_TASKS: not a lifecycle task',
		)
	})

	it('does not report unselected reference tasks as missing', () => {
		const reference = selectReferenceTasks(
			{
				tasks: [row(TASK.restartRootStar, 4), row(TASK.replaceRootStar, 5)],
			},
			[TASK.restartRootStar],
		)
		const comparison = buildComparison([row(TASK.restartRootStar, 3.5)], reference)

		expect(comparison.map(({ name, status }) => ({ name, status }))).toEqual([
			{ name: TASK.restartRootStar, status: 'measured' },
		])
	})
})

describe('plugin lifecycle benchmark reference compatibility', () => {
	it('accepts only the same workload and scenario', () => {
		const compatibility = assessReferenceCompatibility(compatibleReference(), {
			id: WORKLOAD_ID,
			scenario,
		})

		expect(compatibility).toMatchObject({ status: 'compatible', reason: null })
		expect(compatibility.report?.tasks).toHaveLength(1)
	})

	it('preserves and explains a workload-bridge reference', () => {
		const compatibility = assessReferenceCompatibility(
			compatibleReference({
				provenance: {
					method: 'chained-workload-bridge',
					description: 'Legacy and current workloads were calibrated on one runtime.',
				},
			}),
			{ id: WORKLOAD_ID, scenario },
		)
		const current = [row(TASK.restartRootStar, 4)]
		const report = toMainReport({
			recordedAt: '2026-08-23T01:00:00.000Z',
			runtime: { name: 'node', version: '24.0.0' },
			workloadId: WORKLOAD_ID,
			options: {
				scenario,
				selectedTasks: [TASK.restartRootStar],
				timeMs: 5_000,
				warmupTimeMs: 1_000,
				warmupIterations: 60,
				minIterations: null,
			},
			taskMetadata: TASK_METADATA,
			tasks: current,
			comparison: buildComparison(current, compatibility.report),
			referenceCompatibility: compatibility,
		})
		const markdown = renderMarkdown({
			report,
			taskMetadata: TASK_METADATA,
			regressionTolerancePct: 5,
		})

		expect(markdown).toContain('Reference: compatible via chained-workload-bridge')
		expect(markdown).toContain(
			'Reference method: Legacy and current workloads were calibrated on one runtime.',
		)
	})

	it.each([
		[
			'missing workload identity',
			compatibleReference({ workload: undefined }),
			'reference workload identity is missing',
		],
		[
			'different workload identity',
			compatibleReference({ workload: { id: 'legacy-core-lifecycle' } }),
			'workload id differs',
		],
		[
			'missing scenario',
			compatibleReference({ scenario: undefined }),
			'reference scenario is missing',
		],
		[
			'different scenario',
			compatibleReference({ scenario: { ...scenario, starLeaves: 201 } }),
			'scenario differs',
		],
	] as const)('rejects a reference with %s', (_label, candidate, reason) => {
		const compatibility = assessReferenceCompatibility(candidate, {
			id: WORKLOAD_ID,
			scenario,
		})

		expect(compatibility).toMatchObject({ status: 'incompatible' })
		expect(compatibility.reason).toContain(reason)
		expect(compatibility.report).toBeNull()
	})

	it('does not compare matching task names from an incompatible reference and reports why', () => {
		const current = [row(TASK.restartRootStar, 8)]
		const compatibility = assessReferenceCompatibility(
			compatibleReference({ workload: undefined }),
			{
				id: WORKLOAD_ID,
				scenario,
			},
		)
		const comparison = buildComparison(current, compatibility.report)
		const report = toMainReport({
			recordedAt: '2026-08-23T01:00:00.000Z',
			runtime: { name: 'node', version: '24.0.0' },
			workloadId: WORKLOAD_ID,
			options: {
				scenario,
				selectedTasks: [TASK.restartRootStar],
				timeMs: 5_000,
				warmupTimeMs: 1_000,
				warmupIterations: 60,
				minIterations: null,
			},
			taskMetadata: TASK_METADATA,
			tasks: current,
			comparison,
			referenceCompatibility: compatibility,
		})
		const markdown = renderMarkdown({
			report,
			taskMetadata: TASK_METADATA,
			regressionTolerancePct: 5,
		})

		expect(comparison).toMatchObject([{ name: TASK.restartRootStar, status: 'new' }])
		expect(markdown).toContain(`Workload: ${WORKLOAD_ID}`)
		expect(markdown).toContain('Reference: incompatible (reference workload identity is missing)')
		expect(markdown).toContain('baseline reset (incompatible reference)')
	})

	it('keeps diagnostic tasks out of the latency regression gate', () => {
		const comparison = buildComparison(
			[row(TASK.noopStar, 0.03), row(TASK.restartLeafStar, 0.03)],
			{
				tasks: [row(TASK.noopStar, 0.01), row(TASK.restartLeafStar, 0.01)],
			},
		)
		const noop = comparison.find((item) => item.name === TASK.noopStar)!
		const restart = comparison.find((item) => item.name === TASK.restartLeafStar)!

		expect(isLatencyRegression(noop, 5, TASK_METADATA[TASK.noopStar])).toBe(false)
		expect(isLatencyRegression(restart, 5, TASK_METADATA[TASK.restartLeafStar])).toBe(true)
	})
})

describe('plugin lifecycle benchmark decision signals', () => {
	it('keeps a complete current-only topology signal without a reference', () => {
		const current = [row(TASK.replaceRootLarge, 4), row(TASK.replaceRootStar, 2)]
		const comparison = buildComparison(current, null)
		const signal = buildDecisionSignals(current, comparison).find(
			(item) => item.name === 'disconnected background tax: root definition replacement',
		)

		expect(signal).toMatchObject({ current: 2, reference: null, status: 'watch' })
	})

	it('shows when denominator acceleration is driving a larger topology ratio', () => {
		const current = [row(TASK.replaceRootLarge, 4), row(TASK.replaceRootStar, 1)]
		const reference = {
			tasks: [row(TASK.replaceRootLarge, 4), row(TASK.replaceRootStar, 2)],
		}
		const comparison = buildComparison(current, reference)
		const signal = buildDecisionSignals(current, comparison).find(
			(item) => item.name === 'disconnected background tax: root definition replacement',
		)

		expect(signal).toMatchObject({
			current: 4,
			reference: 2,
			deltaPct: 100,
			numeratorDeltaPct: 0,
			denominatorDeltaPct: -50,
			reliable: true,
		})
	})

	it('marks a ratio directional when either source is noisy', () => {
		const current = [row(TASK.replaceRootLarge, 4, 11), row(TASK.replaceRootStar, 2)]
		const reference = {
			tasks: [row(TASK.replaceRootLarge, 4), row(TASK.replaceRootStar, 2)],
		}
		const comparison = buildComparison(current, reference)
		const signal = buildDecisionSignals(current, comparison).find(
			(item) => item.name === 'disconnected background tax: root definition replacement',
		)

		expect(signal?.reliable).toBe(false)
	})
})
