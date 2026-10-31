import { pluginNodeAddressOf } from '@pluxel/core'
import { createStore } from 'tinybase'
import type { Dispatcher } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import { ManagedSettingsStore, WretchSettingsCleanupError } from '../src/managed-settings.ts'
import { ConsumerA, ConsumerB } from '../src/test-fixtures.ts'

describe('provider managed-settings commits', () => {
	it('serializes all consumer rows and publishes each setting only after flush', async () => {
		const store = createStore()
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		const flush = vi
			.fn()
			.mockImplementationOnce(() => gate)
			.mockResolvedValue(undefined)
		const managed = new ManagedSettingsStore(store, flush)
		const a = await managed.load(pluginNodeAddressOf(ConsumerA))
		const b = await managed.load(pluginNodeAddressOf(ConsumerB))
		const first = managed.replace(a, { headers: { 'X-Owner': 'a' } })
		const second = managed.replace(b, { headers: { 'X-Owner': 'b' } })
		let loaded = false
		const loading = managed.load(a.owner).then((state) => {
			loaded = true
			return state
		})
		await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1))
		expect(store.getRowIds('consumerSettings')).toHaveLength(1)
		expect(a.current.headers).toEqual({})
		expect(b.current.headers).toEqual({})
		expect(loaded).toBe(false)
		release()
		await Promise.all([first, second])
		const reloaded = await loading
		expect(reloaded.current.headers).toEqual({ 'x-owner': 'a' })
		expect(a.current.headers).toEqual({ 'x-owner': 'a' })
		expect(b.current.headers).toEqual({ 'x-owner': 'b' })
		expect(store.getRowIds('consumerSettings')).toHaveLength(2)
		await managed.reset(a)
		expect(store.getRowIds('consumerSettings')).toHaveLength(1)
		expect(a.current.headers).toEqual({})
		expect(b.current.headers).toEqual({ 'x-owner': 'b' })
		const restored = new ManagedSettingsStore(createStore().setContent(store.getContent()), flush)
		const restoredB = await restored.load(b.owner)
		const restoredA = await restored.load(a.owner)
		expect(restoredB.current.headers).toEqual({ 'x-owner': 'b' })
		expect(restoredA.current.headers).toEqual({})
	})

	it('blocks the whole provider after a failed save while preserving applied settings', async () => {
		const store = createStore()
		const failure = new Error('backing save failed')
		const flush = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(failure)
		const managed = new ManagedSettingsStore(store, flush)
		const a = await managed.load(pluginNodeAddressOf(ConsumerA))
		const b = await managed.load(pluginNodeAddressOf(ConsumerB))
		await managed.replace(a, { headers: { 'X-Mode': 'confirmed' } })
		await expect(managed.replace(a, { headers: { 'X-Mode': 'candidate' } })).rejects.toBe(failure)
		expect(a.current.headers).toEqual({ 'x-mode': 'confirmed' })
		await expect(managed.replace(b, { headers: { 'X-Other': 'later' } })).rejects.toBe(failure)
		await expect(managed.reset(a)).rejects.toBe(failure)
		await expect(managed.load(a.owner)).rejects.toBe(failure)
		await Promise.all([managed.dispose(a), managed.dispose(b)])
		expect(flush).toHaveBeenCalledTimes(2)
		expect(b.current.headers).toEqual({})
	})

	it('reports cleanup failure after the saved replacement has already become applied', async () => {
		const flush = vi.fn().mockResolvedValue(undefined)
		const managed = new ManagedSettingsStore(createStore(), flush)
		const state = await managed.load(pluginNodeAddressOf(ConsumerA))
		const failure = new Error('old dispatcher close failed')
		state.dispatcher = { close: vi.fn().mockRejectedValue(failure) } as unknown as Dispatcher
		await expect(
			managed.replace(state, { headers: { 'X-Mode': 'applied' } }),
		).rejects.toMatchObject({
			name: 'WretchSettingsCleanupError',
			code: 'SETTINGS_APPLIED_CLEANUP_FAILED',
			applied: true,
			cause: failure,
		})
		expect(state.current.headers).toEqual({ 'x-mode': 'applied' })
		expect(state.dispatcher).toBeUndefined()
		// Resource cleanup failure does not fault the successfully saved Store.
		await expect(managed.reset(state)).resolves.toEqual({ headers: {} })
		expect(new WretchSettingsCleanupError(failure)).toBeInstanceOf(Error)
	})

	it('rejects unsupported stored row formats before exposing managed settings', () => {
		for (const row of [
			{ version: 2, owner: '{}', settings: '{}' },
			{ version: 1, owner: '{}', settings: '{}', extra: true },
			{ version: 1, owner: '{}', settings: 1 },
		]) {
			const store = createStore().setRow('consumerSettings', 'invalid', row)
			expect(() => new ManagedSettingsStore(store, async () => {})).toThrow('unsupported format')
		}
	})
})
