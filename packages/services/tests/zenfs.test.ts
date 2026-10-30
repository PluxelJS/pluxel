import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	bindContext,
	boundContexts,
	configureFileSystem,
	InMemory,
	Passthrough,
	PassthroughFS,
	resolveMountConfig,
	vfs,
	type BoundContext,
	type FileSystem,
} from '@zenfs/core'
import { caches } from '@zenfs/core/vfs/vcache.js'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: BoundContext[] = []
const directories: string[] = []

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-zenfs-'))
	directories.push(directory)
	return directory
}

function context(backing: FileSystem) {
	const bound = bindContext({ root: '/', pwd: '/', mounts: { '/': backing } })
	contexts.push(bound)
	return bound
}

// Instrument actual native handles without replacing the filesystem under test.
function instrumentHandles(instrument: (handle: FileHandle) => void) {
	return {
		...nativeFs,
		promises: {
			...nativeFs.promises,
			async open(...args: Parameters<typeof nativeFs.promises.open>) {
				const handle = await nativeFs.promises.open(...args)
				instrument(handle)
				return handle
			},
		},
	}
}

afterEach(async () => {
	const released = await Promise.allSettled(
		contexts.splice(0).map(async (bound) => {
			try {
				if (!bound.disposed) await bound.dispose()
			} finally {
				await vfs.umountAsync.call(bound, '/')
			}
		}),
	)
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
	const errors = released
		.filter((result) => result.status === 'rejected')
		.map((result) => result.reason)
	if (errors.length > 0) throw new AggregateError(errors, 'Failed to release ZenFS test resources')
})

describe('ZenFS dependency admission', () => {
	it('completes legal short IO, positioned writes, empty overwrites and binary files', async () => {
		const prefix = await temporaryDirectory()
		let reads = 0
		let writes = 0
		const native = instrumentHandles((handle) => {
			const read = handle.read.bind(handle)
			const write = handle.write.bind(handle)
			Object.defineProperties(handle, {
				read: {
					value: (
						input:
							| Uint8Array
							| { buffer: Uint8Array; offset?: number; length?: number; position?: number },
						offset = 0,
						length?: number,
						position?: number,
					) => {
						reads++
						const options =
							input instanceof Uint8Array ? { buffer: input, offset, length, position } : input
						return read({
							...options,
							length: Math.min(
								options.length ?? options.buffer.byteLength - (options.offset ?? 0),
								2,
							),
						})
					},
				},
				write: {
					value: (
						buffer: Uint8Array,
						offset = 0,
						length = buffer.byteLength - offset,
						position?: number,
					) => {
						writes++
						return write(buffer, offset, Math.min(length, 2), position)
					},
				},
			})
		})
		const backing = await resolveMountConfig({ backend: Passthrough, fs: native, prefix })
		const fs = context(backing).fs.promises

		await fs.writeFile('document', 'NEW-CONTENT', { flag: 'wx', mode: 0o600 })
		expect(await readFile(join(prefix, 'document'), 'utf8')).toBe('NEW-CONTENT')
		const created = await stat(join(prefix, 'document'))
		expect(created.mode & 0o777).toBe(0o600)
		expect(await fs.readFile('document', 'utf8')).toBe('NEW-CONTENT')

		const handle = await fs.open('document', 'r+')
		try {
			await handle.write(new TextEncoder().encode('XYZ'), 0, 3, 4)
		} finally {
			await handle.close()
		}
		expect(await readFile(join(prefix, 'document'), 'utf8')).toBe('NEW-XYZTENT')

		await fs.writeFile('document', '')
		expect(await readFile(join(prefix, 'document'), 'utf8')).toBe('')
		const bytes = Uint8Array.from({ length: 257 }, (_, index) => index)
		await fs.writeFile('binary', bytes)
		expect(new Uint8Array(await readFile(join(prefix, 'binary')))).toEqual(bytes)
		expect(new Uint8Array(await fs.readFile('binary'))).toEqual(bytes)
		expect(reads).toBeGreaterThan(1)
		expect(writes).toBeGreaterThan(1)
	})

	it('uses file offsets for synchronous short IO and applies zero-length truncation', async () => {
		const prefix = await temporaryDirectory()
		await writeFile(join(prefix, 'file'), 'abcdefghij')
		const backing = new PassthroughFS(
			{
				...nativeFs,
				readSync: (
					fd: number,
					buffer: NodeJS.ArrayBufferView,
					offset: number | nativeFs.ReadOptions = 0,
					length?: number,
					position?: number,
				) => {
					const options = typeof offset === 'number' ? { offset, length, position } : offset
					return nativeFs.readSync(fd, buffer, {
						...options,
						length: Math.min(options.length ?? buffer.byteLength - (options.offset ?? 0), 2),
					})
				},
				writeSync: (
					fd: number,
					buffer: Uint8Array,
					offset: number = 0,
					length: number = buffer.byteLength - offset,
					position?: number,
				) => nativeFs.writeSync(fd, buffer, offset, Math.min(length, 2), position),
			} as typeof nativeFs,
			prefix,
		)
		backing.writeSync('/file', new TextEncoder().encode('XYZ'), 4)
		expect(await readFile(join(prefix, 'file'), 'utf8')).toBe('abcdXYZhij')
		const bytes = new Uint8Array(6)
		backing.readSync('/file', bytes, 4, 10)
		expect(new TextDecoder().decode(bytes)).toBe('XYZhij')
		backing.touchSync('/file', { ...backing.statSync('/file'), size: 0 })
		const truncated = await stat(join(prefix, 'file'))
		expect(truncated.size).toBe(0)
	})

	it('rejects zero progress and preserves both the IO and cleanup failures', async () => {
		const prefix = await temporaryDirectory()
		await writeFile(join(prefix, 'file'), 'OLD')
		const stalled = new PassthroughFS(
			instrumentHandles((handle) => {
				Object.defineProperties(handle, {
					read: { value: async () => ({ bytesRead: 0 }) },
					write: { value: async () => ({ bytesWritten: 0 }) },
				})
			}),
			prefix,
		)
		await expect(stalled.read('/file', new Uint8Array(1), 0, 1)).rejects.toMatchObject({
			code: 'EIO',
		})
		await expect(stalled.write('/file', new Uint8Array([1]), 0)).rejects.toMatchObject({
			code: 'EIO',
		})

		const ioFailure = new Error('native write failed')
		const closeFailure = new Error('native close failed')
		const failing = new PassthroughFS(
			instrumentHandles((handle) => {
				const close = handle.close.bind(handle)
				Object.defineProperties(handle, {
					write: {
						value: async () => {
							throw ioFailure
						},
					},
					close: {
						value: async () => {
							await close()
							throw closeFailure
						},
					},
				})
			}),
			prefix,
		)
		await expect(failing.write('/file', new Uint8Array([1]), 0)).rejects.toMatchObject({
			error: closeFailure,
			suppressed: ioFailure,
		})
		expect(await readFile(join(prefix, 'file'), 'utf8')).toBe('OLD')
	})

	it.each(['memory', 'node'] as const)(
		'enforces %s readonly mutations without changing existing content',
		async (mode) => {
			const prefix = await temporaryDirectory()
			const backing =
				mode === 'memory'
					? await resolveMountConfig({ backend: InMemory })
					: await resolveMountConfig({ backend: Passthrough, fs: nativeFs, prefix })
			const bound = context(backing)
			const fs = bound.fs.promises
			await fs.writeFile('existing', 'OLD')
			const opened = await fs.open('existing', 'r+')
			configureFileSystem(backing, { readOnly: true })
			try {
				for (const mutate of [
					() => opened.writeFile(''),
					() => opened.truncate(0),
					() => opened.chmod(0o600),
					() => opened.chown(0, 0),
					() => opened.utimes(new Date(), new Date()),
					() => fs.writeFile('existing', ''),
					() => fs.writeFile('existing', 'NEW'),
					() => fs.truncate('existing', 0),
					() => fs.chmod('existing', 0o600),
					() => fs.chown('existing', 0, 0),
					() => fs.utimes('existing', new Date(), new Date()),
					() => fs.unlink('existing'),
					() => fs.rename('existing', 'renamed'),
					() => fs.mkdir('new'),
					() => fs.writeFile('new', 'NEW'),
				])
					await expect(mutate()).rejects.toMatchObject({ code: 'EROFS' })
			} finally {
				await opened.close()
			}
			configureFileSystem(backing, { readOnly: false })
			await expect(fs.writeFile('existing', '')).rejects.toMatchObject({ code: 'EROFS' })
			await expect(fs.readFile('missing')).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await fs.readFile('existing', 'utf8')).toBe('OLD')
			expect(await fs.readdir('.')).toEqual(['existing'])
			const physicalContent =
				mode === 'node'
					? await readFile(join(prefix, 'existing'), 'utf8')
					: await fs.readFile('existing', 'utf8')
			expect(physicalContent).toBe('OLD')
		},
	)

	it('applies readonly configuration during resolution and rejects invalid values before opening a backend', async () => {
		const fs = context(await resolveMountConfig({ backend: InMemory, readOnly: true })).fs.promises
		await expect(fs.readFile('missing')).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(fs.writeFile('new', '')).rejects.toMatchObject({ code: 'EROFS' })
		let creates = 0
		await expect(
			resolveMountConfig({
				backend: {
					...InMemory,
					create(options: Parameters<typeof InMemory.create>[0]) {
						creates++
						return InMemory.create(options)
					},
				},
				readOnly: 'yes' as never,
			}),
		).rejects.toMatchObject({ code: 'EINVAL' })
		expect(creates).toBe(0)
	})

	it('releases repeated owner contexts and open handles without closing their borrowed backend', async () => {
		const before = { contexts: boundContexts.size, caches: caches.size }
		for (let index = 0; index < 10; index++) {
			const backing = await resolveMountConfig({ backend: InMemory })
			const root = context(backing)
			await root.fs.promises.mkdir('owner')
			const owner = root.bind({ root: '/owner', pwd: '/' })
			const handle = await owner.fs.promises.open('document', 'w+')
			await handle.writeFile(`pending-${index}`)
			expect(owner.descriptors.size).toBe(1)
			const disposal = root.dispose()
			expect(root.dispose()).toBe(disposal)
			await disposal
			expect(root.children).toHaveLength(0)
			expect(owner.descriptors.size).toBe(0)
			await expect(handle.readFile()).rejects.toMatchObject({ code: 'EBADF' })
			await expect(owner.fs.promises.readFile('document')).rejects.toMatchObject({ code: 'EBADF' })
			await vfs.umountAsync.call(root, '/')
			const reopened = context(backing)
			expect(await reopened.fs.promises.readFile('/owner/document', 'utf8')).toBe(
				`pending-${index}`,
			)
			await reopened.dispose()
			await vfs.umountAsync.call(reopened, '/')
		}
		expect({ contexts: boundContexts.size, caches: caches.size }).toEqual(before)
	})

	it('waits for cached writes before unmounting an owned backing', async () => {
		const backing = await resolveMountConfig({ backend: InMemory })
		const root = context(backing)
		const handle = await root.fs.promises.open('document', 'w+')
		await handle.writeFile('pending')
		const write = backing.write.bind(backing)
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		backing.write = async (...args) => {
			entered.resolve()
			await release.promise
			return write(...args)
		}
		const disposal = root.dispose()
		await entered.promise
		let unmounted = false
		const unmount = (async () => {
			await vfs.umountAsync.call(root, '/')
			unmounted = true
		})()
		try {
			await Promise.resolve()
			expect(unmounted).toBe(false)
			expect(root.mounts.size).toBe(1)
		} finally {
			release.resolve()
			await Promise.all([disposal, unmount])
		}
		expect(root.mounts.size).toBe(0)
		expect(caches.has(backing.uuid)).toBe(false)
	})

	it('reports failed final writes while releasing contexts, descriptors and owned caches', async () => {
		const before = boundContexts.size
		const backing = await resolveMountConfig({ backend: InMemory })
		const root = context(backing)
		const handle = await root.fs.promises.open('document', 'w+')
		await handle.writeFile('pending')
		const failure = new Error('backing write failed')
		backing.write = async () => {
			throw failure
		}
		await expect(root.dispose()).rejects.toMatchObject({ errors: [failure] })
		expect(root.descriptors.size).toBe(0)
		expect(boundContexts.size).toBe(before)
		await expect(vfs.umountAsync.call(root, '/')).rejects.toBe(failure)
		expect(root.mounts.size).toBe(0)
		expect(caches.has(backing.uuid)).toBe(false)
	})
})
