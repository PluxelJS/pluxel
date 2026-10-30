import * as nativeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	BasePlugin,
	Plugin,
	PluginPart,
	encodePluginNodeAddressBytes,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { createHost, defineHostService } from '@pluxel/host'
import { createTestHost } from '@pluxel/test'
import { boundContexts } from '@zenfs/core'
import { caches } from '@zenfs/core/vfs/vcache.js'
import {
	Fs,
	PluginFs,
	fs,
	InMemory,
	Passthrough,
	writeFileAtomic,
	type FsServiceConfig,
	type FsPromises,
	type FsService,
} from '../src/fs'
import { pluginNodePhysicalKey } from '../src/internal/plugin-address'
import { afterEach, describe, expect, it, vi } from 'vitest'

const directories: string[] = []
async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-fs-'))
	directories.push(directory)
	return directory
}
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FilePart extends PluginPart<FileOwner> {
	async readDocument() {
		const directory = await this.ctx.require(PluginFs)()
		return directory.readFile('document', 'utf8')
	}
}

@Plugin()
class FileOwner extends BasePlugin {
	readonly directory = this.ctx.require(PluginFs)
	readonly filesPart = this.parts.use(FilePart)
}

describe('Host-owned filesystem', () => {
	it('rejects malformed declarations and requirements instead of applying truthy defaults', async () => {
		for (const config of [
			{},
			{ backend: InMemory, readOnly: 'false' },
			{ backend: InMemory, disableAsyncCache: 'false' },
			{ backend: InMemory, caseFold: 'unicode' },
			{ backend: InMemory, readonly: true },
			{ backend: { ...InMemory } },
		])
			expect(() => fs(config as never)).toThrow(TypeError)
		const host = await createHost({ plugins: [], services: [fs({ backend: InMemory })] })
		try {
			const invalidRequirements: readonly unknown[] = [
				true,
				null,
				[],
				{ durabl: true },
				{ writable: 'false' },
			]
			for (const requirement of invalidRequirements)
				await expect(host.ctx.require(Fs).ready(requirement as never)).rejects.toThrow(TypeError)
		} finally {
			await host.close()
		}
	})

	it('resolves document factories before IO and shares bootstrap preparation with service prepare', async () => {
		const prefix = join(await temporaryDirectory(), 'data')
		const calls: string[] = []
		const native = {
			...nativeFs,
			promises: {
				...nativeFs.promises,
				mkdir: (async (...args: Parameters<typeof nativeFs.promises.mkdir>) => {
					if (args[0] === prefix) calls.push('open')
					return nativeFs.promises.mkdir(...args)
				}) as typeof nativeFs.promises.mkdir,
			},
		}
		const storage = fs({ backend: Passthrough, fs: native, prefix })
		expect(calls).toEqual([])
		const host = await createHost({
			plugins: [],
			services: [storage],
			configRecords: {
				storage: (root) => {
					calls.push('config factory')
					return root.require(Fs).documents('host/config')
				},
			},
			state: {
				storage: (root) => {
					calls.push('state factory')
					return root.require(Fs).documents('host/state')
				},
			},
		})
		try {
			expect(() => {
				// @ts-expect-error Owner-only capability is deliberately unavailable to root.
				host.ctx.require(PluginFs)
			}).toThrow(Error)
			expect(calls.slice(0, 3)).toEqual(['config factory', 'state factory', 'open'])
			expect(calls.filter((call) => call === 'open')).toHaveLength(1)
			const first = await host.ctx.require(Fs).directory('services/example')
			const second = await host.ctx.require(Fs).directory('services/example')
			expect(second).toBe(first)
			await writeFileAtomic(first, 'empty', '')
			expect(await readFile(join(prefix, 'services/example/empty'), 'utf8')).toBe('')
		} finally {
			await host.close()
		}
	})

	it('shares a failed bootstrap preparation without reopening or retrying it', async () => {
		const failure = Object.assign(new Error('native mkdir failed'), { code: 'EACCES' })
		let attempts = 0
		let selected: FsService
		const native = {
			...nativeFs,
			promises: {
				...nativeFs.promises,
				async mkdir() {
					attempts++
					throw failure
				},
			},
		}
		await expect(
			createHost({
				plugins: [],
				services: [fs({ backend: Passthrough, fs: native, prefix: await temporaryDirectory() })],
				configRecords: {
					storage: (root) => {
						selected = root.require(Fs)
						const documents = selected.documents('host/config')
						return {
							...documents,
							async getText(key) {
								const outcomes = await Promise.allSettled([
									documents.getText(key),
									selected.ready(),
									documents.getText(key),
								])
								expect(outcomes).toEqual(
									Array.from({ length: 3 }, () => ({ status: 'rejected', reason: failure })),
								)
								await expect(selected.ready()).rejects.toBe(failure)
								throw failure
							},
						}
					},
				},
			}),
		).rejects.toBe(failure)
		expect(attempts).toBe(1)
		await expect(selected!.ready()).rejects.toMatchObject({ code: 'EBADF' })
	})

	it('closes an opened filesystem when Host configuration is corrupt and preserves the document', async () => {
		const before = { contexts: boundContexts.size, caches: caches.size }
		const prefix = await temporaryDirectory()
		const path = join(prefix, 'host/config/config.json')
		await nativeFs.promises.mkdir(join(prefix, 'host/config'), { recursive: true })
		await nativeFs.promises.writeFile(path, '{broken', { mode: 0o600 })
		let selected: FsService
		await expect(
			createHost({
				plugins: [],
				services: [fs({ backend: Passthrough, fs: nativeFs, prefix })],
				configRecords: {
					storage: (root) => {
						selected = root.require(Fs)
						return selected.documents('host/config')
					},
				},
			}),
		).rejects.toThrow(/Cannot load config.json/)
		expect(await readFile(path, 'utf8')).toBe('{broken')
		await expect(selected!.ready()).rejects.toMatchObject({ code: 'EBADF' })
		expect({ contexts: boundContexts.size, caches: caches.size }).toEqual(before)
	})

	it('keeps each Host independent and gives Plugins a stable directory through restart', async () => {
		await using first = await createTestHost({ services: [fs({ backend: InMemory })] })
		await using second = await createTestHost({ services: [fs({ backend: InMemory })] })
		const owner = await first.start(FileOwner)
		const getDirectory = owner.directory
		const directory = await getDirectory()
		await writeFileAtomic(directory, 'document', 'PRESERVE')
		expect(await owner.filesPart.readDocument()).toBe('PRESERVE')
		const other = await second.start(FileOwner)
		const otherDirectory = await other.directory()
		await expect(otherDirectory.readFile('document')).rejects.toMatchObject({ code: 'ENOENT' })
		await first.stop(FileOwner)
		const restarted = await first.start(FileOwner)
		expect(await restarted.directory()).toBe(directory)
		expect(await restarted.filesPart.readDocument()).toBe('PRESERVE')
		expect(await directory.readFile('document', 'utf8')).toBe('PRESERVE')
	})

	it('preserves canonical address bytes and fork identity in portable physical keys', () => {
		const address = pluginNodeAddressOf(FileOwner)
		const fork = { ...address, variant: 'fork' as const, forkId: 'example' }
		for (const node of [address, fork])
			expect(pluginNodePhysicalKey(node)).toBe(
				createHash('sha256').update(encodePluginNodeAddressBytes(node)).digest('hex'),
			)
		expect(pluginNodePhysicalKey(address)).not.toBe(pluginNodePhysicalKey(fork))
	})

	it.each(['memory', 'node'] as const)(
		'preserves the old %s document when atomic replacement fails',
		async (mode) => {
			const prefix = await temporaryDirectory()
			const config: FsServiceConfig =
				mode === 'memory' ? { backend: InMemory } : { backend: Passthrough, fs: nativeFs, prefix }
			const host = await createHost({ plugins: [], services: [fs(config)] })
			try {
				const directory = await host.ctx.require(Fs).directory('documents')
				await writeFileAtomic(directory, 'document', 'OLD')
				const failure = Object.assign(new Error('replace failed'), { code: 'EIO' })
				const rename = vi.spyOn(directory, 'rename').mockRejectedValueOnce(failure)
				await expect(writeFileAtomic(directory, 'document', 'NEW')).rejects.toBe(failure)
				rename.mockRestore()
				expect(await directory.readFile('document', 'utf8')).toBe('OLD')
				expect(await directory.readdir('.')).toEqual(['document'])
			} finally {
				await host.close()
			}
		},
	)

	it('retains the primary failure when temporary-file cleanup also fails', async () => {
		const host = await createHost({ plugins: [], services: [fs({ backend: InMemory })] })
		try {
			const directory = await host.ctx.require(Fs).directory('documents')
			await writeFileAtomic(directory, 'document', 'OLD')
			const primary = Object.assign(new Error('replace failed'), { code: 'EIO' })
			const cleanup = Object.assign(new Error('unlink failed'), { code: 'EACCES' })
			vi.spyOn(directory, 'rename').mockRejectedValueOnce(primary)
			vi.spyOn(directory, 'unlink').mockRejectedValueOnce(cleanup)
			await expect(writeFileAtomic(directory, 'document', 'NEW')).rejects.toMatchObject({
				name: 'AggregateError',
				cause: primary,
				errors: [primary, cleanup],
			})
			expect(await directory.readFile('document', 'utf8')).toBe('OLD')
		} finally {
			await host.close()
		}
	})

	it('requires durability honestly and rejects writes on a readonly native backend', async () => {
		const memory = await createHost({ plugins: [], services: [fs({ backend: InMemory })] })
		try {
			await expect(memory.ctx.require(Fs).ready({ durable: true })).rejects.toMatchObject({
				code: 'ENOTSUP',
			})
		} finally {
			await memory.close()
		}
		const prefix = await temporaryDirectory()
		const config = { backend: Passthrough, fs: nativeFs, prefix } as const
		const writable = await createHost({ plugins: [], services: [fs(config)] })
		await writable.ctx.require(Fs).documents('host/config').put('settings.json', 'OLD')
		await writable.close()
		const readonly = await createHost({
			plugins: [],
			services: [fs({ ...config, readOnly: true })],
		})
		try {
			const documents = readonly.ctx.require(Fs).documents('host/config')
			expect(await documents.getText('settings.json')).toBe('OLD')
			await expect(documents.put('settings.json', '')).rejects.toMatchObject({ code: 'EROFS' })
			expect(await readonly.ctx.require(Fs).documents('missing').getText('absent')).toBeUndefined()
			expect(await readdir(prefix)).toEqual(['host'])
		} finally {
			await readonly.close()
		}
	})

	it('flushes runtime work before final disposal and rejects further use of borrowed directories', async () => {
		let directory: FsPromises
		const prefix = await temporaryDirectory()
		const host = await createHost({
			plugins: [],
			services: [
				fs({ backend: Passthrough, fs: nativeFs, prefix }),
				defineHostService({
					name: 'Last write',
					capabilities: [],
					requires: { fs: Fs },
					async prepare({ dependencies, effects }) {
						directory = await dependencies.fs.directory('services/final')
						effects.defer(() => writeFileAtomic(directory, 'last', 'FINAL'))
					},
				}),
			],
		})
		await host.close()
		expect(await readFile(join(prefix, 'services/final/last'), 'utf8')).toBe('FINAL')
		await expect(directory!.readFile('last')).rejects.toMatchObject({ code: 'EBADF' })
		await expect(host.ctx.require(Fs).directory('other')).rejects.toMatchObject({ code: 'EBADF' })
	})
	it('releases owned contexts, handles and caches after repeated Host creation', async () => {
		const before = { contexts: boundContexts.size, caches: caches.size }
		for (let index = 0; index < 10; index++) {
			const host = await createHost({ plugins: [], services: [fs({ backend: InMemory })] })
			const directory = await host.ctx.require(Fs).directory('services/owned')
			const handle = await directory.open('pending', 'w+')
			await handle.writeFile(`pending-${index}`)
			await host.close()
			await expect(handle.readFile()).rejects.toMatchObject({ code: 'EBADF' })
		}
		expect({ contexts: boundContexts.size, caches: caches.size }).toEqual(before)
	})
})
