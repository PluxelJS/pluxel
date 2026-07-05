import { withRuntimeHost } from '@pluxel/runtime/test'
import { createWorkspacePersistenceBackend } from '@pluxel/runtime'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

function createMemoryFsLike() {
	const files = new Map<string, Uint8Array>()
	const encode = (text: string) => new TextEncoder().encode(text)
	const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
	const missing = (path: string) => Object.assign(new Error(`Missing file: ${path}`), { code: 'ENOENT' })

	return {
		files,
		backend: {
			exists: (path: string) => files.has(path),
			readText: async (path: string) => {
				const value = files.get(path)
				if (!value) throw missing(path)
				return decode(value)
			},
			writeTextAtomic: async (path: string, text: string) => {
				files.set(path, encode(text))
			},
			readBytes: async (path: string) => {
				const value = files.get(path)
				if (!value) throw missing(path)
				return Uint8Array.from(value)
			},
			writeBytesAtomic: async (path: string, bytes: Uint8Array) => {
				files.set(path, Uint8Array.from(bytes))
			},
			unlink: async (path: string) => {
				if (!files.delete(path)) throw missing(path)
			},
			readdir: async (path: string) => {
				const prefix = path.endsWith('/') ? path : `${path}/`
				const names = new Set<string>()
				for (const key of files.keys()) {
					if (!key.startsWith(prefix)) continue
					const name = key.slice(prefix.length).split('/')[0]
					if (name) names.add(name)
				}
				if (names.size === 0) throw missing(path)
				return [...names].sort()
			},
			stat: async (path: string) => {
				const value = files.get(path)
				return value ? { type: 'file' as const, size: value.byteLength, mtimeMs: 0 } : { type: 'missing' as const }
			},
		},
	}
}

describe('PersistenceService (runtime)', () => {
	it('provides namespaced memory persistence with explicit capability', async () => {
		await withRuntimeHost(
			async (host) => {
				const ns = host.ctx.root.persistence.namespace('runtime-test')

				await ns.put('a.txt', 'hello')
				await ns.put('nested/b.bin', new Uint8Array([1, 2, 3]))
				await ns.put('nested-other.bin', 'nope')

				expect(host.ctx.root.persistence.capability).toBe('ephemeral')
				expect(await ns.getText('a.txt')).toBe('hello')
				expect(await ns.stat('nested/b.bin')).toMatchObject({
					key: 'nested/b.bin',
					kind: 'file',
					size: 3,
				})

				const entries: string[] = []
				for await (const entry of ns.list()) entries.push(entry.key)
				expect(entries).toEqual(['a.txt', 'nested-other.bin', 'nested/b.bin'])

				const nestedEntries: string[] = []
				for await (const entry of ns.list('nested')) nestedEntries.push(entry.key)
				expect(nestedEntries).toEqual(['nested/b.bin'])

				await expect(
					host.ctx.root.persistence.preflight({ durable: true }),
				).rejects.toThrow(/ephemeral/)
			},
			{ persistence: { mode: 'memory' } },
		)
	})

	it('wraps text/blob backends with explicit capability and forgiving missing operations', async () => {
		const fs = createMemoryFsLike()
		const backend = createWorkspacePersistenceBackend(fs.backend, {
			capability: 'ephemeral',
			root: 'scoped-root',
		})
		const ns = backend.namespace('fs-adapter-test')

		expect(backend.capability).toBe('ephemeral')
		await expect(backend.preflight({ durable: true })).rejects.toThrow(/ephemeral/)
		await expect(ns.delete('missing.txt')).resolves.toBeUndefined()

		const missingEntries: string[] = []
		for await (const entry of ns.list('missing-dir')) missingEntries.push(entry.key)
		expect(missingEntries).toEqual([])

		await ns.put('dir/a.txt', 'hello')
		expect(await ns.getText('dir/a.txt')).toBe('hello')

		const entries: string[] = []
		for await (const entry of ns.list('dir')) entries.push(entry.key)
		expect(entries).toEqual(['dir/a.txt'])
		expect([...fs.files.keys()].sort()).toEqual([resolve('scoped-root/fs-adapter-test/dir/a.txt')])
	})
})
