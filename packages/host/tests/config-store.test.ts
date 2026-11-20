import { type PluginNodeAddress } from '@pluxel/core'
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
it.each([
	'{',
	SuperJSON.stringify([]),
	SuperJSON.stringify({ version: 3, plugins: [] }),
	SuperJSON.stringify({ version: 4, plugins: {} }),
])('preserves invalid documents and rejects preparation', async (body) => {
	const storage = createDocumentStorage()
	await storage.put('config.json', body)
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(ctx, undefined, { storage })
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
	expect(() => snapshotHostConfig({}, undefined, [{ owner, config: { value } }])).toThrow(
		/portable|data properties|dense/,
	)
})
it('rejects duplicate and empty records, preserves mode-only entries, and merges empty objects correctly', () => {
	expect(() => snapshotHostConfig({}, undefined, [{ owner }])).toThrow('requires mode or config')
	expect(() =>
		snapshotHostConfig({}, undefined, [
			{ owner, mode: 'saved-first' },
			{ owner, config: {} },
		]),
	).toThrow('duplicates')
	expect(snapshotHostConfig({}, undefined, [{ owner, mode: 'saved-first' }]).records[0]).toEqual({
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
	expect(() => snapshotHostConfig({}, undefined, records)).toThrow(/data elements/)
	expect(reads).toBe(0)
	expect(() => snapshotHostConfig({}, undefined, Array(1))).toThrow(/dense/)
	expect(() => snapshotHostConfig({}, undefined, Object.assign([], { extra: true }))).toThrow(
		/dense/,
	)
})
