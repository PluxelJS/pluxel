import { TASK, TASK_NAMES, selectTaskNames } from './catalog'
import {
	buildComparison,
	buildDecisionSignals,
	selectReferenceTasks,
	type BenchRow,
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

describe('plugin lifecycle benchmark decision signals', () => {
	it('keeps a complete current-only topology signal without a reference', () => {
		const current = [row(TASK.replaceRootStar, 4), row(TASK.replaceLeafStar, 0.1)]
		const comparison = buildComparison(current, null)
		const signal = buildDecisionSignals(current, comparison).find(
			(item) => item.name === 'cascade tax: root HMR',
		)

		expect(signal).toMatchObject({ current: 40, reference: null, status: 'watch' })
	})

	it('shows when denominator acceleration is driving a larger topology ratio', () => {
		const current = [row(TASK.replaceRootStar, 4), row(TASK.replaceLeafStar, 0.05)]
		const reference = {
			tasks: [row(TASK.replaceRootStar, 4), row(TASK.replaceLeafStar, 0.1)],
		}
		const comparison = buildComparison(current, reference)
		const signal = buildDecisionSignals(current, comparison).find(
			(item) => item.name === 'cascade tax: root HMR',
		)

		expect(signal).toMatchObject({
			current: 80,
			reference: 40,
			deltaPct: 100,
			numeratorDeltaPct: 0,
			denominatorDeltaPct: -50,
			reliable: true,
		})
	})

	it('marks a ratio directional when either source is noisy', () => {
		const current = [row(TASK.replaceRootStar, 4, 11), row(TASK.replaceLeafStar, 0.1)]
		const reference = {
			tasks: [row(TASK.replaceRootStar, 4), row(TASK.replaceLeafStar, 0.1)],
		}
		const comparison = buildComparison(current, reference)
		const signal = buildDecisionSignals(current, comparison).find(
			(item) => item.name === 'cascade tax: root HMR',
		)

		expect(signal?.reliable).toBe(false)
	})
})
