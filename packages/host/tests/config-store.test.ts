import type { PluginNodeAddress } from '@pluxel/core'
import { createCoreContextHost } from '@pluxel/core/host'
import { SuperJSON } from 'superjson'
import { expect, it } from 'vitest'
import { HostConfigStore } from '../src/config-store'
import type { HostDocumentStorage } from '../src/index'
import { createDocumentStorage } from './helpers/document-storage'

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/config-store' },
		exportName: 'Owner',
	},
	variant: 'default',
}

it('loads existing readonly config ahead of initial values and rejects mutation', async () => {
	const storage = createDocumentStorage()
	const persisted = SuperJSON.stringify({
		version: 3,
		plugins: [{ owner, config: { value: 'persisted' } }],
	})
	await storage.put('config.json', persisted)
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(ctx, {
		storage,
		mode: 'readonly',
		initial: [{ owner, config: { value: 'startup' } }],
	})
	try {
		await store.ready
		expect(store.getRawConfig(owner)).toEqual({ value: 'persisted' })
		expect(() => store.patchConfig(owner, { value: 'changed' })).toThrow(/readonly mode/i)
		expect(await storage.getText('config.json')).toBe(persisted)
	} finally {
		await ctx.effects.dispose()
	}
})

it('keeps initial values when readonly config is absent without creating a document', async () => {
	const storage = createDocumentStorage()
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(ctx, {
		storage,
		mode: 'readonly',
		initial: [{ owner, config: { value: 'startup' } }],
	})
	try {
		await store.ready
		expect(store.getRawConfig(owner)).toEqual({ value: 'startup' })
		expect(await storage.stat('config.json')).toBeUndefined()
	} finally {
		await ctx.effects.dispose()
	}
})

it.each([
	['malformed', '{'],
	['unsupported version', SuperJSON.stringify({ version: 2, plugins: [] })],
])('rejects %s readonly config without isolating or rewriting it', async (_case, text) => {
	const storage = createDocumentStorage()
	await storage.put('config.json', text)
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(ctx, { storage, mode: 'readonly' })
	try {
		await expect(store.ready).rejects.toThrow(/ConfigService/)
		expect(await storage.getText('config.json')).toBe(text)
		expect([...storage.documents.keys()]).toEqual(['config.json'])
	} finally {
		await ctx.effects.dispose()
	}
})

it('requests atomic writes, retains failed work for retry, and recreates a deleted committed file', async () => {
	const memory = createDocumentStorage()
	const writes: boolean[] = []
	let rejectWrite = false
	const storage: HostDocumentStorage = {
		...memory,
		async put(key, value, options) {
			writes.push(options?.atomic === true)
			if (rejectWrite) throw new Error('config storage unavailable')
			await memory.put(key, value, options)
		},
	}
	const ctx = createCoreContextHost().createRoot()
	const store = new HostConfigStore(ctx, { storage })
	try {
		await store.ready
		writes.length = 0
		store.patchConfig(owner, { value: 'desired' })
		rejectWrite = true
		await expect(store.flush()).rejects.toThrow('config storage unavailable')
		expect(writes).toEqual([true])
		rejectWrite = false
		await store.flush()
		expect(writes).toEqual([true, true])
		memory.documents.delete('config.json')
		store.patchConfig(owner, { value: 'temporary' })
		store.patchConfig(owner, { value: 'desired' })
		await store.flush()
		expect(await memory.stat('config.json')).toBeDefined()
	} finally {
		await ctx.effects.dispose()
	}
})
