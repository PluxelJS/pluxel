import { PersistenceService } from '../src/persistence/service'
import {
	createMemoryPersistenceBackend,
	createNodePersistenceBackend,
	createReadonlyPersistenceBackend,
	createWorkspacePersistenceBackend,
} from '@pluxel/services/persistence'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

function createMemoryFsLike() {
	const files = new Map<string, Uint8Array>()
	const encode = (text: string) => new TextEncoder().encode(text)
	const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
	const missing = (path: string) =>
		Object.assign(new Error(`Missing file: ${path}`), { code: 'ENOENT' })

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
				return value
					? { type: 'file' as const, size: value.byteLength, mtimeMs: 0 }
					: { type: 'missing' as const }
			},
		},
	}
}

describe('Persistence backends', () => {
	it('provides namespaced memory persistence with explicit capability', async () => {
		{
			const storage = new PersistenceService({ mode: 'memory' })

			const ns = storage.namespace('runtime-test')

			await ns.put('a.txt', 'hello')
			await ns.put('nested/b.bin', new Uint8Array([1, 2, 3]))
			await ns.put('nested-other.bin', 'nope')

			expect(storage.capability).toBe('ephemeral')
			expect(await ns.getText('a.txt')).toBe('hello')
			expect(await ns.stat('nested/b.bin')).toMatchObject({
				key: 'nested/b.bin',
				kind: 'file',
				size: 3,
			})

			const entries: string[] = []
			for await (const entry of ns.list()) entries.push(entry.key)
			expect(entries).toEqual(['a.txt', 'nested', 'nested-other.bin'])

			const nestedEntries: string[] = []
			for await (const entry of ns.list('nested')) nestedEntries.push(entry.key)
			expect(nestedEntries).toEqual(['nested/b.bin'])

			await expect(storage.preflight({ durable: true })).rejects.toThrow(/ephemeral/)
		}
	})

	it('enforces declared capabilities when a custom backend omits preflight', async () => {
		const memory = createMemoryPersistenceBackend()
		const backend = {
			capability: memory.capability,
			namespace: memory.namespace,
		}

		{
			const storage = new PersistenceService({ mode: 'custom', backend })

			await expect(storage.preflight({ durable: true })).rejects.toMatchObject({
				code: 'UNAVAILABLE',
			})
		}
	})

	it('supports built-in Node file persistence with a configured directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pluxel-persistence-'))
		try {
			{
				const storage = new PersistenceService(dir)

				const ns = storage.namespace('runtime-test')
				expect(storage.capability).toBe('durable')
				await expect(storage.preflight({ durable: true, writable: true })).resolves.toBeUndefined()
				await ns.put('a.txt', 'hello')
				await ns.put('nested/b.bin', new Uint8Array([1, 2, 3]))
			}

			{
				const storage = new PersistenceService(dir)

				const ns = storage.namespace('runtime-test')
				expect(await ns.getText('a.txt')).toBe('hello')
				expect(await ns.get('nested/b.bin')).toEqual(new Uint8Array([1, 2, 3]))
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('rejects invalid storage configuration', () => {
		expect(() => new PersistenceService({} as never)).toThrow(/invalid persistence config/i)
	})

	it('wraps text/blob backends with explicit capability and forgiving missing operations', async () => {
		const fs = createMemoryFsLike()
		const backend = createWorkspacePersistenceBackend(fs.backend, {
			capability: 'ephemeral',
			root: 'scoped-root',
		})
		const ns = backend.namespace('fs-adapter-test')

		expect(backend.capability).toBe('ephemeral')
		await expect(backend.preflight!({ durable: true })).rejects.toThrow(/ephemeral/)
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

describe.each(['memory', 'node'] as const)('%s persistence contract', (mode) => {
	it('preserves names, rejects aliases and lists immediate directories', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-persistence-contract-'))
		try {
			const backend =
				mode === 'memory'
					? createMemoryPersistenceBackend()
					: createNodePersistenceBackend({ root })
			for (const invalid of [
				'',
				'/absolute',
				'../escape',
				'a/../b',
				'./a',
				'a//b',
				'a/',
				'C:/a',
				'a\\b',
			]) {
				expect(() => backend.namespace(invalid)).toThrow(TypeError)
				await expect(backend.namespace('safe').put(invalid, 'x')).rejects.toThrow(TypeError)
			}
			const ns = backend.namespace('@pluxel/wretch')
			await ns.put('nested/deep/file', 'hello')
			await ns.put('nested/second', 'world')
			expect(await backend.namespace('_pluxel/wretch').getText('nested/second')).toBeUndefined()
			expect(await Array.fromAsync(ns.list())).toMatchObject([{ key: 'nested', kind: 'directory' }])
			expect(await Array.fromAsync(ns.list('nested'))).toMatchObject([
				{ key: 'nested/deep', kind: 'directory' },
				{ key: 'nested/second', kind: 'file' },
			])
			expect(await ns.stat('nested/deep')).toMatchObject({ key: 'nested/deep', kind: 'directory' })
			await ns.delete('nested/deep/file')
			expect(await ns.stat('nested/deep')).toMatchObject({ kind: 'directory' })
			await expect(Array.fromAsync(ns.list('../outside'))).rejects.toThrow(TypeError)
			await expect(ns.put('nested', 'overwrite')).rejects.toThrow(
				/Cannot overwrite a directory|Failed to write file/,
			)
			await expect(ns.put('nested/second/child', 'overwrite')).rejects.toThrow(
				/Parent is a file|EEXIST|ENOTDIR/,
			)
			await expect(ns.delete('nested')).rejects.toThrow(
				/Cannot delete a directory|Failed to unlink/,
			)
			await expect(ns.get('nested')).rejects.toThrow(/Cannot read a directory|Failed to read file/)
			await expect(Array.fromAsync(ns.list('nested/second'))).rejects.toThrow(
				/Cannot list a file|Failed to readdir/,
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

it('enforces every readonly entry path without writing to the delegate', async () => {
	const fs = createMemoryFsLike()
	const direct = createWorkspacePersistenceBackend(fs.backend, { capability: 'readonly' })
	const custom = new PersistenceService({
		mode: 'custom',
		backend: {
			capability: 'readonly',
			namespace: createMemoryPersistenceBackend().namespace,
		},
	})
	for (const backend of [
		direct,
		createReadonlyPersistenceBackend(createMemoryPersistenceBackend()),
		custom,
	]) {
		const ns = backend.namespace('cached')
		await expect(ns.put('key', 'no')).rejects.toMatchObject({ code: 'READONLY' })
		await expect(ns.delete('key')).rejects.toMatchObject({ code: 'READONLY' })
		await expect(backend.preflight!({ writable: true })).rejects.toMatchObject({ code: 'READONLY' })
	}
	expect(fs.files.size).toBe(0)
})
