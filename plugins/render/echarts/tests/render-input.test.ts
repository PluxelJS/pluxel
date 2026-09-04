import { describe, expect, it } from 'vitest'
import { assertRenderDataBudget } from '../src/render-input.ts'

const unlimitedSignal = new AbortController().signal

describe('ECharts render input admission', () => {
	it('rejects option graphs that exceed the configured bounded walk', async () => {
		await expect(
			assertRenderDataBudget(
				[{ series: [{ type: 'line', data: [1, 2, 3, 4, 5, 6, 7, 8] }] }],
				{ maxBytes: 1_024, maxNodes: 8, maxDepth: 16 },
				unlimitedSignal,
			),
		).rejects.toMatchObject({ code: 'OPTION_TOO_LARGE' })

		await expect(
			assertRenderDataBudget(
				[{ title: { text: 'Pluxel' } }],
				{ maxBytes: 8, maxNodes: 32, maxDepth: 16 },
				unlimitedSignal,
			),
		).rejects.toMatchObject({ code: 'OPTION_TOO_LARGE' })
	})

	it('rejects imperative values without evaluating accessors', async () => {
		let getterCalled = false
		const accessorOption = Object.defineProperty({}, 'series', {
			enumerable: true,
			get() {
				getterCalled = true
				return []
			},
		})

		await expect(
			assertRenderDataBudget([accessorOption], generousLimits, unlimitedSignal),
		).rejects.toMatchObject({ code: 'WORKER_INPUT_UNSUPPORTED' })
		expect(getterCalled).toBe(false)
		await expect(
			assertRenderDataBudget([{ formatter: () => 'inline' }], generousLimits, unlimitedSignal),
		).rejects.toMatchObject({ code: 'WORKER_INPUT_UNSUPPORTED' })
	})

	it('cooperatively observes cancellation while measuring a long UTF-8 string', async () => {
		const controller = new AbortController()
		const reason = new Error('cancel option measurement')
		const measuring = assertRenderDataBudget(
			[{ title: { text: '界'.repeat(1024 * 1024) } }],
			{ maxBytes: 4 * 1024 * 1024, maxNodes: 32, maxDepth: 16 },
			controller.signal,
		)

		setImmediate(() => controller.abort(reason))
		await expect(measuring).rejects.toBe(reason)
	})
})

const generousLimits = { maxBytes: 1024 * 1024, maxNodes: 4_096, maxDepth: 64 } as const
