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
import { createCoreTestHost, getCoreTestHostContext } from '../src/internal-test'
import { requireFs } from '../src/internal/storage'
import { boundContexts } from '@zenfs/core'
import { caches } from '@zenfs/core/vfs/vcache.js'
import { InMemory, Passthrough, writeFileAtomic, type FsConfig } from '../src/fs'
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
		const directory = await this.ctx.fs()
		return directory.readFile('document', 'utf8')
	}
}

@Plugin()
class FileOwner extends BasePlugin {
	readonly directory = this.ctx.fs
	readonly filesPart = this.parts.use(FilePart)
}

describe('Core-owned filesystem', () => {
	it('rejects malformed declarations and requirements instead of applying truthy defaults', async () => {
		for (const config of [
			null,
			{ readOnly: 'false' },
			{ disableAsyncCache: 'false' },
			{ caseFold: 'unicode' },
			{ readonly: true },
			{ mounts: { '/': {} } },
			{ mounts: { '/': { backend: InMemory, readOnly: 'false' } } },
			{ durableMounts: ['/missing'] },
			{ log: {} },
			{ disableAccessChecks: true },
			{ resolveFullWalk: true },
			{ onlySyncOnClose: true },
		])
			expect(() => createCoreTestHost({ storage: config } as never)).toThrow(TypeError)
		const host = await createCoreTestHost({ storage: { mounts: { '/': { backend: InMemory } } } })
		try {
			const invalidRequirements: readonly unknown[] = [
				true,
				null,
				[],
				{ durabl: true },
				{ writable: 'false' },
			]
			for (const requirement of invalidRequirements)
				await expect(
					requireFs(getCoreTestHostContext(host)).ready(requirement as never),
				).rejects.toThrow(TypeError)
		} finally {
			await host.dispose()
		}
	})

	it('borrows document adapters before IO and single-flights preparation for all callers', async () => {
		const prefix = join(await temporaryDirectory(), 'data')
		await nativeFs.promises.mkdir(prefix)
		const calls: string[] = []
		const backend = {
			...Passthrough,
			create(options: Parameters<typeof Passthrough.create>[0]) {
				calls.push('open')
				return Passthrough.create(options)
			},
		}
		await using host = createCoreTestHost({
			storage: { mounts: { '/': { backend, fs: nativeFs, prefix } } },
		})
		const root = getCoreTestHostContext(host)
		const filesystem = requireFs(root)
		const config = filesystem.documents('host/config')
		const state = filesystem.documents('host/state')
		expect(calls).toEqual([])
		// @ts-expect-error A Core root has no Plugin directory.
		expect(root.fs).toBeUndefined()
		// @ts-expect-error A Core root has no Plugin Store bridge.
		expect(root.tinybase).toBeUndefined()
		await Promise.all([config.getText('missing'), state.getText('missing'), filesystem.ready()])
		expect(calls).toEqual(['open'])
		const first = await filesystem.directory('services/example')
		const second = await filesystem.directory('services/example')
		expect(second).toBe(first)
		await writeFileAtomic(first, 'empty', '')
		expect(await readFile(join(prefix, 'services/example/empty'), 'utf8')).toBe('')
	})

	it('shares a failed preparation without reopening or retrying it', async () => {
		const failure = Object.assign(new Error('native backend failed'), { code: 'EACCES' })
		let attempts = 0
		const backend = {
			...Passthrough,
			create() {
				attempts++
				throw failure
			},
		}
		const host = createCoreTestHost({
			storage: { mounts: { '/': { backend, fs: nativeFs, prefix: await temporaryDirectory() } } },
		})
		const filesystem = requireFs(getCoreTestHostContext(host))
		const documents = filesystem.documents('host/config')
		const outcomes = await Promise.allSettled([
			documents.getText('config.json'),
			filesystem.ready(),
			documents.getText('config.json'),
		])
		expect(outcomes).toEqual(
			Array.from({ length: 3 }, () => ({ status: 'rejected', reason: failure })),
		)
		await expect(filesystem.ready()).rejects.toBe(failure)
		expect(attempts).toBe(1)
		await host.dispose()
		await expect(filesystem.ready()).rejects.toMatchObject({ code: 'EBADF' })
	})

	it('releases an opened filesystem after document decoding fails and preserves its bytes', async () => {
		const before = { contexts: boundContexts.size, caches: caches.size }
		const prefix = await temporaryDirectory()
		const path = join(prefix, 'host/config/config.json')
		await nativeFs.promises.mkdir(join(prefix, 'host/config'), { recursive: true })
		await nativeFs.promises.writeFile(path, '{broken', { mode: 0o600 })
		const host = createCoreTestHost({
			storage: { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } },
		})
		const filesystem = requireFs(getCoreTestHostContext(host))
		try {
			const text = await filesystem.documents('host/config').getText('config.json')
			expect(() => JSON.parse(text!)).toThrow(SyntaxError)
		} finally {
			await host.dispose()
		}
		expect(await readFile(path, 'utf8')).toBe('{broken')
		await expect(filesystem.ready()).rejects.toMatchObject({ code: 'EBADF' })
		expect({ contexts: boundContexts.size, caches: caches.size }).toEqual(before)
	})

	it('keeps each Host independent and gives Plugins a stable directory through restart', async () => {
		await using first = await createCoreTestHost({
			storage: { mounts: { '/': { backend: InMemory } } },
		})
		await using second = await createCoreTestHost({
			storage: { mounts: { '/': { backend: InMemory } } },
		})
		const owner = await first.add(FileOwner)
		const getDirectory = owner.directory
		const directory = await getDirectory()
		await writeFileAtomic(directory, 'document', 'PRESERVE')
		expect(await owner.filesPart.readDocument()).toBe('PRESERVE')
		const other = await second.add(FileOwner)
		const otherDirectory = await other.directory()
		await expect(otherDirectory.readFile('document')).rejects.toMatchObject({ code: 'ENOENT' })
		await first.remove(FileOwner)
		const restarted = await first.add(FileOwner)
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
			const config: FsConfig = {
				mounts: {
					'/': mode === 'memory' ? InMemory : { backend: Passthrough, fs: nativeFs, prefix },
				},
			}
			const host = await createCoreTestHost({ storage: config })
			try {
				const directory = await requireFs(getCoreTestHostContext(host)).directory('documents')
				await writeFileAtomic(directory, 'document', 'OLD')
				const failure = Object.assign(new Error('replace failed'), { code: 'EIO' })
				const rename = vi.spyOn(directory, 'rename').mockRejectedValueOnce(failure)
				await expect(writeFileAtomic(directory, 'document', 'NEW')).rejects.toBe(failure)
				rename.mockRestore()
				expect(await directory.readFile('document', 'utf8')).toBe('OLD')
				expect(await directory.readdir('.')).toEqual(['document'])
			} finally {
				await host.dispose()
			}
		},
	)

	it('retains the primary failure when temporary-file cleanup also fails', async () => {
		const host = await createCoreTestHost({ storage: { mounts: { '/': { backend: InMemory } } } })
		try {
			const directory = await requireFs(getCoreTestHostContext(host)).directory('documents')
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
			await host.dispose()
		}
	})

	it('requires durability honestly and rejects writes on a readonly native backend', async () => {
		const memory = await createCoreTestHost({ storage: { mounts: { '/': { backend: InMemory } } } })
		try {
			await expect(
				requireFs(getCoreTestHostContext(memory)).ready({ durable: true }),
			).rejects.toMatchObject({
				code: 'ENOTSUP',
			})
		} finally {
			await memory.dispose()
		}
		const prefix = await temporaryDirectory()
		const config = { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } } as const
		const writable = await createCoreTestHost({ storage: config })
		await requireFs(getCoreTestHostContext(writable))
			.documents('host/config')
			.put('settings.json', 'OLD')
		await writable.dispose()
		const readonly = await createCoreTestHost({
			storage: { ...config, readOnly: true },
		})
		try {
			const documents = requireFs(getCoreTestHostContext(readonly)).documents('host/config')
			expect(await documents.getText('settings.json')).toBe('OLD')
			await expect(documents.put('settings.json', '')).rejects.toMatchObject({ code: 'EROFS' })
			expect(
				await requireFs(getCoreTestHostContext(readonly)).documents('missing').getText('absent'),
			).toBeUndefined()
			expect(await readdir(prefix)).toEqual(['host'])
		} finally {
			await readonly.dispose()
		}
	})

	it('flushes runtime work before final disposal and rejects further use of borrowed directories', async () => {
		const prefix = await temporaryDirectory()
		const host = createCoreTestHost({
			storage: { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } },
		})
		const root = getCoreTestHostContext(host)
		const filesystem = requireFs(root)
		const directory = await filesystem.directory('services/final')
		root.effects.defer(() => writeFileAtomic(directory, 'last', 'FINAL'))
		await host.dispose()
		expect(await readFile(join(prefix, 'services/final/last'), 'utf8')).toBe('FINAL')
		await expect(directory.readFile('last')).rejects.toMatchObject({ code: 'EBADF' })
		await expect(filesystem.directory('other')).rejects.toMatchObject({ code: 'EBADF' })
	})
	it('releases owned contexts, handles and caches after repeated Host creation', async () => {
		const before = { contexts: boundContexts.size, caches: caches.size }
		for (let index = 0; index < 10; index++) {
			const host = await createCoreTestHost({ storage: { mounts: { '/': { backend: InMemory } } } })
			const directory = await requireFs(getCoreTestHostContext(host)).directory('services/owned')
			const handle = await directory.open('pending', 'w+')
			await handle.writeFile(`pending-${index}`)
			await host.dispose()
			await expect(handle.readFile()).rejects.toMatchObject({ code: 'EBADF' })
		}
		expect({ contexts: boundContexts.size, caches: caches.size }).toEqual(before)
	})
})
