import { describe, expect, it, vi } from 'vitest'
import { openPluginSources } from '../src/source-session'
import type { PluginSource, PluginSourceOpenOptions } from '../src/sources'

describe('source session ownership', () => {
	it('captures opening changes, preserves overlapping ownership, and rejects late events', async () => {
		const callbacks: PluginSourceOpenOptions[] = []
		const closes = [vi.fn(), vi.fn()]
		const sources: PluginSource[] = closes.map((close) => ({
			covers: () => true,
			async open(options) {
				callbacks.push(options)
				options.onChange({ type: 'add', path: 'late.mjs' })
				return {
					entries: ['shared.mjs'],
					close: async () => {
						close()
					},
				}
			},
		}))
		const onChange = vi.fn()
		const session = await openPluginSources({ root: '/', sources, onChange, onError: vi.fn() })
		expect(session.entries()).toEqual(['late.mjs', 'shared.mjs'])
		expect(onChange).not.toHaveBeenCalled()
		callbacks[0]!.onChange({ type: 'unlink', path: 'shared.mjs' })
		expect(onChange).not.toHaveBeenCalled()
		callbacks[1]!.onChange({ type: 'unlink', path: 'shared.mjs' })
		expect(onChange).toHaveBeenCalledWith({ type: 'unlink', path: 'shared.mjs' })
		const closing = session.close()
		callbacks[0]!.onChange({ type: 'add', path: 'after-close.mjs' })
		await closing
		await session.close()
		expect(session.entries()).toEqual(['late.mjs'])
		for (const close of closes) expect(close).toHaveBeenCalledOnce()
	})

	it('closes successful sources when another source cannot open', async () => {
		const close = vi.fn(async () => {})
		await expect(
			openPluginSources({
				root: '/',
				onChange: vi.fn(),
				onError: vi.fn(),
				sources: [
					{ covers: () => true, open: async () => ({ entries: [], close }) },
					{
						covers: () => true,
						open: async () => {
							throw new Error('source failed')
						},
					},
				],
			}),
		).rejects.toThrow('source startup failed')
		expect(close).toHaveBeenCalledOnce()
	})
})
