import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { createMemoryPersistenceBackend, createWorkspacePersistenceBackend } from '@pluxel/runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'pathe'
import { describe, expect, it, vi } from 'vitest'

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

describe('PersistenceService (runtime)', () => {
	it('provides namespaced memory persistence with explicit capability', async () => {
		{
			await using host = createRuntimeInternalTestHost({ persistence: { mode: 'memory' } })

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

			await expect(host.ctx.root.persistence.preflight({ durable: true })).rejects.toThrow(
				/ephemeral/,
			)
		}
	})

	it('enforces declared capabilities when a custom backend omits preflight', async () => {
		const memory = createMemoryPersistenceBackend()
		const backend = {
			capability: memory.capability,
			namespace: memory.namespace,
		}

		{
			await using host = createRuntimeInternalTestHost({
				persistence: { mode: 'custom', backend },
			})

			await expect(host.ctx.root.persistence.preflight({ durable: true })).rejects.toMatchObject({
				code: 'UNAVAILABLE',
			})
		}
	})

	it('supports built-in Node file persistence with a configured directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pluxel-persistence-'))
		try {
			{
				await using host = createRuntimeInternalTestHost({ persistence: dir })

				const ns = host.ctx.root.persistence.namespace('runtime-test')
				expect(host.ctx.root.persistence.capability).toBe('durable')
				await expect(
					host.ctx.root.persistence.preflight({ durable: true, writable: true }),
				).resolves.toBeUndefined()
				await ns.put('a.txt', 'hello')
				await ns.put('nested/b.bin', new Uint8Array([1, 2, 3]))
			}

			{
				await using host = createRuntimeInternalTestHost({ persistence: dir })

				const ns = host.ctx.root.persistence.namespace('runtime-test')
				expect(await ns.getText('a.txt')).toBe('hello')
				expect(await ns.get('nested/b.bin')).toEqual(new Uint8Array([1, 2, 3]))
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('warns once when implicit memory persistence receives writes', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		try {
			{
				await using host = createRuntimeInternalTestHost({ persistence: undefined })

				const ns = host.ctx.root.persistence.namespace('runtime-test')
				await ns.put('a.txt', 'hello')
				await ns.put('b.txt', 'again')
				expect(warn).toHaveBeenCalledTimes(1)
				expect(warn.mock.calls[0]?.[0]).toContain('implicit in-memory persistence')
			}
		} finally {
			warn.mockRestore()
		}
	})

	it('rejects object-shaped file compatibility config', async () => {
		await expect(
			(async () => {
				await using _host = createRuntimeInternalTestHost({
					persistence: {} as never,
				})

				return undefined
			})(),
		).rejects.toThrow(/invalid persistence config/i)
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
