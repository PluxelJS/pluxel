import type { PluginNodeAddress } from '@pluxel/core'
import { createCoreContextHost } from '@pluxel/core/host'
import { SuperJSON } from 'superjson'
import { expect, it } from 'vitest'
import { HostConfigStore } from '../src/config-store'
import { snapshotHostConfig, mergeRecord } from '../src/config-records'
import { createDocumentStorage } from './helpers/document-storage'

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/config-store' },
		exportName: 'Owner',
	},
	variant: 'default',
}
it.each(['declared-only', 'declared-first', 'saved-first'] as const)(
	'selects %s without writing declarations or normalized output',
	async (mode) => {
		const storage = createDocumentStorage()
		const body = SuperJSON.stringify({
			version: 4,
			plugins: [{ owner, config: { value: 'saved', extra: 1 } }],
		})
		await storage.put('config.json', body)
		const ctx = createCoreContextHost().createRoot()
		const store = new HostConfigStore(
			ctx,
			{ mode, records: [{ owner, config: { value: 'declared' } }] },
			{ storage, readOnly: true },
		)
		try {
			await store.ready
			expect(store.composeConfig(owner)).toEqual(
				mode === 'declared-only'
					? { value: 'declared' }
					: { value: mode === 'saved-first' ? 'saved' : 'declared', extra: 1 },
			)
			expect(() => store.patchConfig(owner, { value: 'x' })).toThrow(/readonly/)
			expect(await storage.getText('config.json')).toBe(body)
		} finally {
			await ctx.effects.dispose()
		}
	},
)
it.each([false, true])('does not create an absent document (readonly=%s)', async (readOnly) => {
	const storage = createDocumentStorage()
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(
		ctx,
		{ records: [{ owner, config: { value: 'declared' } }] },
		{ storage, readOnly },
	)
	try {
		await store.ready
		expect(store.getManagedInput(owner)).toBeNull()
		expect(store.composeConfig(owner)).toEqual({ value: 'declared' })
		expect(await storage.stat('config.json')).toBeUndefined()
	} finally {
		await ctx.effects.dispose()
	}
})
it.each([
	'{',
	SuperJSON.stringify([]),
	SuperJSON.stringify({ version: 3, plugins: [] }),
	SuperJSON.stringify({ version: 4, plugins: {} }),
])('preserves invalid documents and rejects preparation', async (body) => {
	const storage = createDocumentStorage()
	await storage.put('config.json', body)
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(ctx, {}, { storage })
	try {
		await expect(store.ready).rejects.toThrow(/Existing document unchanged/)
		expect(await storage.getText('config.json')).toBe(body)
	} finally {
		await ctx.effects.dispose()
	}
})
it.each([
	undefined,
	NaN,
	Infinity,
	new Date(),
	() => 1,
	Symbol('x'),
	Object.defineProperty({}, 'x', {
		get() {
			throw new Error('getter executed')
		},
		enumerable: true,
	}),
	Array(2),
])('rejects nonportable config input without coercion', (value) => {
	expect(() => snapshotHostConfig({ records: [{ owner, config: { value } }] })).toThrow(
		/portable|data properties|dense/,
	)
})
it('rejects duplicate and empty records, preserves mode-only entries, and merges empty objects correctly', () => {
	expect(() => snapshotHostConfig({ records: [{ owner }] })).toThrow('requires mode or config')
	expect(() =>
		snapshotHostConfig({
			records: [
				{ owner, mode: 'saved-first' },
				{ owner, config: {} },
			],
		}),
	).toThrow('duplicates')
	expect(snapshotHostConfig({ records: [{ owner, mode: 'saved-first' }] }).records[0]).toEqual({
		owner,
		mode: 'saved-first',
	})
	expect(mergeRecord({ nested: 4 }, { nested: {} })).toEqual({ nested: {} })
	expect(mergeRecord({ nested: { value: 4 } }, { nested: {} })).toEqual({ nested: { value: 4 } })
})

it('replaces arrays and tuples as complete values while retaining explicit null', () => {
	expect(
		mergeRecord(
			{ items: [{ a: 1, b: 2 }], pair: ['old', 1], nullable: 'old' },
			{ items: [{ a: 3 }], pair: ['new', 2], nullable: null },
		),
	).toEqual({ items: [{ a: 3 }], pair: ['new', 2], nullable: null })
})

it('rejects sparse or behavioral record arrays without invoking element getters', () => {
	let reads = 0
	const records = Object.defineProperty([], '0', {
		enumerable: true,
		get() {
			reads++
			return { owner, config: {} }
		},
	})
	expect(() => snapshotHostConfig({ records })).toThrow(/data elements/)
	expect(reads).toBe(0)
	expect(() => snapshotHostConfig({ records: Array(1) })).toThrow(/dense/)
	expect(() => snapshotHostConfig({ records: Object.assign([], { extra: true }) })).toThrow(/dense/)
})
