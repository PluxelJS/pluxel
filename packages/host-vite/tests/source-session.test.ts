import { describe, expect, it, vi } from 'vitest'
import { openPluginSources, type PluginSourceOpenOptions } from '../src/source-session'
import { watchPluginSource } from '../src/sources-watch'
vi.mock('../src/sources-watch', () => ({ watchPluginSource: vi.fn() }))
import type { PluginSource } from '@pluxel/host/sources'

describe('source session ownership', () => {
	it('captures opening changes, preserves overlapping ownership, and rejects late events', async () => {
		const callbacks: PluginSourceOpenOptions[] = []
		const closes = [vi.fn(), vi.fn()]
		const sources: PluginSource[] = closes.map((_, i) => ({ kind: 'file', path: String(i) }))
		vi.mocked(watchPluginSource).mockImplementation(async (source, options) => {
			callbacks.push(options)
			options.onChange({ type: 'add', path: 'late.mjs' })
			return {
				entries: async () => ['late.mjs', 'shared.mjs'],
				covers: (path) => path === 'shared.mjs',
				close: async () => {
					closes[Number(source.path)]!()
				},
			}
		})
		const onChange = vi.fn()
		const session = await openPluginSources({ root: '/', sources, onChange, onError: vi.fn() })
		expect(await session.entries()).toEqual(['late.mjs', 'shared.mjs'])
		expect(session.covers('shared.mjs')).toBe(true)
		expect(onChange).not.toHaveBeenCalled()
		callbacks[0]!.onChange({ type: 'unlink', path: 'shared.mjs' })
		expect(onChange).not.toHaveBeenCalled()
		callbacks[1]!.onChange({ type: 'unlink', path: 'shared.mjs' })
		expect(onChange).toHaveBeenCalledWith({ type: 'unlink', path: 'shared.mjs' })
		const closing = session.close()
		expect(session.covers('shared.mjs')).toBe(false)
		callbacks[0]!.onChange({ type: 'add', path: 'after-close.mjs' })
		await closing
		await session.close()
		await expect(session.entries()).rejects.toThrow('source session is closed')
		for (const close of closes) expect(close).toHaveBeenCalledOnce()
	})

	it('closes successful sources when another source cannot open', async () => {
		const close = vi.fn(async () => {})
		vi.mocked(watchPluginSource).mockImplementation(async (source) => {
			if (source.path === 'failed') throw new Error('source failed')
			return { entries: async () => [], covers: () => false, close }
		})
		await expect(
			openPluginSources({
				root: '/',
				onChange: vi.fn(),
				onError: vi.fn(),
				sources: [
					{ kind: 'file', path: 'good' },
					{ kind: 'file', path: 'failed' },
				],
			}),
		).rejects.toThrow('source failed')
		expect(close).toHaveBeenCalledOnce()
	})
})
