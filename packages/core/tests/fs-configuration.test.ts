import * as nativeFs from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	InMemory,
	Passthrough,
	PassthroughFS,
	CopyOnWrite,
	FileSystem,
	boundContexts,
	type Backend,
} from '@zenfs/core'
import { caches } from '@zenfs/core/vfs/vcache.js'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic, type FsConfig } from '../src/fs'
import { createCoreTestHost, getCoreTestHostContext } from '../src/internal-test'
import { requireFs } from '../src/internal/storage'

const directories: string[] = []
async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-fs-configuration-'))
	directories.push(directory)
	return directory
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function filesystem(config: FsConfig) {
	const host = createCoreTestHost({ zenfs: config })
	return { host, fs: requireFs(getCoreTestHostContext(host)) }
}

function terminalErrors(error: unknown): unknown[] {
	return error instanceof AggregateError ? error.errors.flatMap(terminalErrors) : [error]
}

function trackedBackend(
	events: string[],
	label: string,
	readyFailure?: unknown,
	closeFailure?: unknown,
) {
	return {
		...InMemory,
		create(options: Parameters<typeof InMemory.create>[0]) {
			events.push(`create:${label}`)
			const fs = InMemory.create(options)
			const ready = fs.ready.bind(fs)
			fs.ready = async () => {
				if (readyFailure !== undefined) throw readyFailure
				await ready()
			}
			fs.close = async () => {
				events.push(`close:${label}`)
				if (closeFailure !== undefined) throw closeFailure
			}
			return fs
		},
	} satisfies Backend
}

describe('native ZenFS storage assembly', () => {
	it('creates separate native mounts, preserves opaque options and does not modify reusable configurations', async () => {
		const prefix = await temporaryDirectory()
		const options = { backend: Passthrough, fs: nativeFs, prefix }
		const config = {
			mounts: { '/': InMemory, '/documents': options, '/scratch': InMemory, '/scratch2': InMemory },
			durableMounts: ['/documents'],
		}
		const { host, fs } = filesystem(config)
		await using _cleanup = host
		const documents = await fs.directory('documents', { durable: true, writable: true })
		await writeFileAtomic(documents, 'record', 'REAL')
		expect(await readFile(join(prefix, 'record'), 'utf8')).toBe('REAL')
		await expect(fs.directory('scratch', { durable: true })).rejects.toMatchObject({
			code: 'ENOTSUP',
		})
		const scratch = await fs.directory('scratch')
		await scratch.writeFile('isolated', 'scratch')
		const root = await fs.directory('scratch2')
		await expect(root.readFile('isolated')).rejects.toMatchObject({ code: 'ENOENT' })
		expect(config.mounts['/documents']).toBe(options)
		expect(Object.keys(options)).toEqual(['backend', 'fs', 'prefix'])
	})

	it('resolves nested native backends and closes every created layer once', async () => {
		const events: string[] = []
		const config = {
			mounts: {
				'/': {
					backend: CopyOnWrite,
					readable: { backend: trackedBackend(events, 'readable') },
					writable: { backend: trackedBackend(events, 'writable') },
				},
			},
		}
		const { host, fs } = filesystem(config)
		const files = await fs.directory('composed')
		await writeFileAtomic(files, 'value', 'COMPOSED')
		expect(await files.readFile('value', 'utf8')).toBe('COMPOSED')
		expect(config.mounts['/'].readable).not.toHaveProperty('uuid')
		await host.dispose()
		expect(events).toEqual([
			'create:readable',
			'create:writable',
			'close:writable',
			'close:readable',
		])
	})

	it('checks the mounted subtree instead of guessing persistence or writability from a backend name', async () => {
		const prefix = await temporaryDirectory()
		const { host, fs } = filesystem({
			mounts: {
				'/': InMemory,
				'/persistent': { backend: { ...Passthrough, name: 'InMemory' }, fs: nativeFs, prefix },
				'/persistent/volatile': InMemory,
				'/persistent/readonly': { backend: InMemory, readOnly: true },
			},
			durableMounts: ['/persistent'],
		})
		await using _cleanup = host
		await fs.directory('persistent/ordinary', { durable: true, writable: true })
		await expect(fs.directory('persistent', { durable: true })).rejects.toMatchObject({
			code: 'ENOTSUP',
		})
		await expect(fs.directory('persistent', { writable: true })).rejects.toMatchObject({
			code: 'EROFS',
		})
		await expect(fs.directory('persistent/readonly', { writable: true })).rejects.toMatchObject({
			code: 'EROFS',
		})
		await expect(fs.ready({ durable: true })).rejects.toMatchObject({ code: 'ENOTSUP' })
	})

	it('retains preparation and rollback failures, closes partial graphs and does not retry', async () => {
		const before = { contexts: boundContexts.size, caches: caches.size }
		const events: string[] = []
		const failure = new Error('custom backend ready failed')
		const cleanupFailure = new Error('custom backend close failed')
		const { host, fs } = filesystem({
			mounts: {
				'/': trackedBackend(events, 'root'),
				'/failing': trackedBackend(events, 'failing', failure, cleanupFailure),
			},
		})
		const outcomes = await Promise.allSettled([fs.ready(), fs.ready()])
		expect(outcomes[0]).toMatchObject({
			status: 'rejected',
			reason: { cause: failure, errors: [failure, { errors: [cleanupFailure] }] },
		})
		expect(outcomes[1]).toEqual(outcomes[0])
		await expect(fs.ready()).rejects.toBe((outcomes[0] as PromiseRejectedResult).reason)
		expect(events).toEqual(['create:root', 'create:failing', 'close:failing', 'close:root'])
		await expect(host.dispose()).rejects.toBeDefined()
		expect({ contexts: boundContexts.size, caches: caches.size }).toEqual(before)
	})

	it('rejects cyclic mount graphs before opening and preserves mount-point IO errors', async () => {
		const events: string[] = []
		const cyclic = { backend: CopyOnWrite, readable: InMemory, writable: {} }
		cyclic.writable = cyclic
		expect(() => filesystem({ mounts: { '/': cyclic } })).toThrow(/cyclic/)
		const root = InMemory.create({})
		const stat = root.stat.bind(root)
		const failure = Object.assign(new Error('cannot inspect mount point'), { code: 'EACCES' })
		root.stat = async (path) => {
			if (path === '/blocked') throw failure
			return stat(path)
		}
		const { host, fs } = filesystem({
			mounts: { '/': root, '/blocked': trackedBackend(events, 'child') },
		})
		await expect(fs.ready()).rejects.toBe(failure)
		await host.dispose()
		expect(events).toEqual(['create:child', 'close:child'])
		await root.close()
	})

	it('shares child disposal with a custom composing backend', async () => {
		const events: string[] = []
		const composite = {
			name: 'ComposingBackend',
			options: { child: { type: 'object', required: true } },
			create(options: { child: FileSystem & { close(): Promise<void> } }) {
				const parent = InMemory.create({})
				parent.close = async () => {
					events.push('close:parent')
					await options.child.close()
				}
				return parent
			},
		} satisfies Backend<FileSystem, { child: FileSystem & { close(): Promise<void> } }>
		const { host, fs } = filesystem({
			mounts: { '/': { backend: composite, child: trackedBackend(events, 'child') } },
		})
		await fs.ready()
		await host.dispose()
		expect(events).toEqual(['create:child', 'close:parent', 'close:child'])
	})

	it.each(['close', 'asyncDispose', 'dispose'] as const)(
		'keeps a nested borrowed child open when its parent invokes %s',
		async (protocol) => {
			const events: string[] = []
			const child = InMemory.create({})
			const close = child.close.bind(child)
			const mkdirChild = child.mkdir.bind(child)
			let closed = false
			child.mkdir = async (...args) => {
				if (closed) throw new Error('borrowed child was closed')
				return mkdirChild(...args)
			}
			child.close = async () => {
				closed = true
				events.push('close:child')
				await close()
			}
			Object.assign(child, {
				[Symbol.asyncDispose]: child.close,
				[Symbol.dispose]: () => {
					closed = true
					events.push('dispose:child')
				},
			})
			const key =
				protocol === 'close'
					? 'close'
					: protocol === 'asyncDispose'
						? Symbol.asyncDispose
						: Symbol.dispose
			const composite = {
				name: 'BorrowingBackend',
				options: { child: { type: 'object', required: true } },
				create(options: { child: FileSystem }) {
					const parent = InMemory.create({})
					parent.close = async () => {
						events.push('close:parent')
						const release = Reflect.get(options.child, key) as () => unknown
						await release.call(options.child)
					}
					return parent
				},
			} satisfies Backend<FileSystem, { child: FileSystem }>
			const parent = filesystem({ mounts: { '/': { backend: composite, child } } })
			const witness = filesystem({ mounts: { '/': child } })
			try {
				await parent.fs.ready()
				await parent.host.dispose()
				expect(events).toEqual(['close:parent'])
				const files = await witness.fs.directory('still-live')
				await writeFileAtomic(files, 'record', 'BORROWED_CHILD')
				expect(await files.readFile('record', 'utf8')).toBe('BORROWED_CHILD')
			} finally {
				await parent.host.dispose()
				await witness.host.dispose()
				await child.close()
			}
			expect(events).toEqual(['close:parent', 'close:child'])
		},
	)

	it('releases newly created resources through the native async disposal protocol', async () => {
		const released: string[] = []
		const backend = {
			...InMemory,
			create(options: Parameters<typeof InMemory.create>[0]) {
				const fs = InMemory.create(options)
				Object.assign(fs, {
					[Symbol.asyncDispose]: async () => {
						released.push('asyncDispose')
					},
				})
				fs.close = async () => {
					released.push('close')
				}
				return fs
			},
		}
		const { host, fs } = filesystem({ mounts: { '/': backend } })
		await fs.ready()
		await Promise.all([host.dispose(), host.dispose()])
		expect(released).toEqual(['asyncDispose'])
	})

	it.each([false, true])(
		'shares synchronous-only child disposal and retains synchronous failures: %s',
		async (failing) => {
			const failure = new Error('synchronous child disposal failed')
			const events: string[] = []
			const observed: unknown[] = []
			const child = {
				...InMemory,
				create(options: Parameters<typeof InMemory.create>[0]) {
					const fs = InMemory.create(options)
					Reflect.set(fs, 'close', undefined)
					return Object.assign(fs, {
						[Symbol.dispose]() {
							events.push('syncDispose:child')
							if (failing) throw failure
						},
					})
				},
			}
			const composite = {
				name: 'SynchronousDisposingBackend',
				options: { child: { type: 'object', required: true } },
				create(options: { child: FileSystem & Disposable }) {
					const parent = InMemory.create({})
					parent.close = async () => {
						events.push('close:parent')
						for (let attempt = 0; attempt < 2; attempt++)
							try {
								options.child[Symbol.dispose]()
							} catch (error) {
								observed.push(error)
							}
					}
					return parent
				},
			} satisfies Backend<FileSystem, { child: FileSystem & Disposable }>
			const { host, fs } = filesystem({ mounts: { '/': { backend: composite, child } } })
			await fs.ready()
			const closing = await Promise.allSettled([host.dispose()])
			expect(closing[0]?.status).toBe(failing ? 'rejected' : 'fulfilled')
			expect(
				closing.flatMap((result) =>
					result.status === 'rejected' ? terminalErrors(result.reason) : [],
				),
			).toEqual(failing ? [failure] : [])
			expect(observed).toEqual(failing ? [failure, failure] : [])
			expect(events).toEqual(['close:parent', 'syncDispose:child'])
		},
	)

	it('selects one preferred disposal protocol across parent calls and Core finalization', async () => {
		const events: string[] = []
		const child = {
			...InMemory,
			create(options: Parameters<typeof InMemory.create>[0]) {
				const fs = InMemory.create(options)
				fs.close = async () => {
					events.push('close:child')
				}
				return Object.assign(fs, {
					async [Symbol.asyncDispose]() {
						await Promise.resolve()
						events.push('asyncDispose:child')
					},
					[Symbol.dispose]() {
						events.push('syncDispose:child')
					},
				})
			},
		}
		const composite = {
			name: 'MixedDisposingBackend',
			options: { child: { type: 'object', required: true } },
			create(options: {
				child: FileSystem & Disposable & AsyncDisposable & { close(): Promise<void> }
			}) {
				const parent = InMemory.create({})
				parent.close = async () => {
					events.push('close:parent')
					options.child[Symbol.dispose]()
					await options.child.close()
					await options.child[Symbol.asyncDispose]()
				}
				return parent
			},
		} satisfies Backend<
			FileSystem,
			{ child: FileSystem & Disposable & AsyncDisposable & { close(): Promise<void> } }
		>
		const { host, fs } = filesystem({ mounts: { '/': { backend: composite, child } } })
		await fs.ready()
		await host.dispose()
		expect(events).toEqual(['close:parent', 'asyncDispose:child'])
	})

	it('preserves fixed own methods and private receivers through a custom composing backend', async () => {
		const prefix = await temporaryDirectory()
		const events: string[] = []
		class FixedMethodsFS extends PassthroughFS {
			#closed = false
			constructor() {
				super(nativeFs, prefix)
				Object.defineProperties(this, {
					ready: { value: this.ready.bind(this) },
					close: { value: this.close.bind(this) },
				})
			}
			override async ready() {
				if (this.#closed) throw new Error('fixed-method resource is closed')
				await super.ready()
			}
			override async read(...args: Parameters<FileSystem['read']>) {
				if (this.#closed) throw new Error('fixed-method resource is closed')
				await super.read(...args)
			}
			async close() {
				this.#closed = true
				events.push('close:child')
			}
		}
		const child = {
			name: 'FixedMethodsBackend',
			options: {},
			create: () => new FixedMethodsFS(),
		} satisfies Backend<FixedMethodsFS>
		const composite = {
			name: 'FixedMethodsComposition',
			options: { child: { type: 'object', required: true } },
			create(options: { child: FixedMethodsFS }) {
				expect(options.child).toBeInstanceOf(FixedMethodsFS)
				const close = options.child.close
				return Object.assign(new PassthroughFS(nativeFs, prefix), {
					async close() {
						events.push('close:parent')
						await close.call(options.child)
					},
				})
			},
		} satisfies Backend<FileSystem, { child: FixedMethodsFS }>
		const { host, fs } = filesystem({ mounts: { '/': { backend: composite, child } } })
		const files = await fs.directory('fixed-methods')
		await writeFileAtomic(files, 'record', 'FIXED')
		expect(await files.readFile('record', 'utf8')).toBe('FIXED')
		await host.dispose()
		expect(events).toEqual(['close:parent', 'close:child'])
	})

	it('uses a normal second ZenFS copy for custom Backend and borrowed FileSystem inputs', async () => {
		const require = createRequire(import.meta.url)
		const source = await realpath(dirname(dirname(require.resolve('@zenfs/core'))))
		const installation = await temporaryDirectory()
		const modules = join(installation, 'node_modules')
		const copy = join(modules, '@zenfs/core')
		await mkdir(dirname(copy), { recursive: true })
		await cp(source, copy, { recursive: true })
		const sourceModules = dirname(dirname(source))
		for (const name of await readdir(sourceModules)) {
			if (name === '@zenfs' || name === '.bin') continue
			if (name === 'memium')
				await cp(await realpath(join(sourceModules, name)), join(modules, name), {
					recursive: true,
				})
			else await symlink(join(sourceModules, name), join(modules, name))
		}
		await symlink(join(sourceModules, '@zenfs/streams'), join(modules, '@zenfs/streams'))
		const foreign = (await import(
			/* @vite-ignore */ pathToFileURL(join(copy, 'dist/index.js')).href
		)) as typeof import('@zenfs/core')
		expect(foreign.FileSystem).not.toBe(FileSystem)
		const foreignGraph = filesystem({
			mounts: {
				'/': {
					backend: foreign.CopyOnWrite,
					readable: foreign.InMemory,
					writable: foreign.InMemory,
				},
			},
		})
		try {
			const files = await foreignGraph.fs.directory('native-composition')
			await writeFileAtomic(files, 'record', 'FOREIGN_GRAPH')
			expect(await files.readFile('record', 'utf8')).toBe('FOREIGN_GRAPH')
		} finally {
			await foreignGraph.host.dispose()
		}

		const prefix = await temporaryDirectory()
		const closes: string[] = []
		class CustomFS extends foreign.PassthroughFS {
			#closed = false
			override async read(...args: Parameters<FileSystem['read']>) {
				if (this.#closed) throw new Error('external resource was closed')
				await super.read(...args)
			}
			async close() {
				this.#closed = true
				closes.push(this.prefix)
			}
		}
		const custom = {
			name: 'ApplicationBackend',
			options: { prefix: { type: 'string', required: true } },
			create: (options: { prefix: string }) => new CustomFS(nativeFs, options.prefix),
		} satisfies Backend<CustomFS, { prefix: string }>
		const first = filesystem({ mounts: { '/': { backend: custom, prefix } }, durableMounts: ['/'] })
		const files = await first.fs.directory('documents', { durable: true })
		await writeFileAtomic(files, 'record', 'EXTERNAL')
		await first.host.dispose()
		expect(closes).toEqual([prefix])
		const borrowed = new CustomFS(nativeFs, prefix)
		const readonly = filesystem({ mounts: { '/': borrowed }, readOnly: true })
		const writable = filesystem({ mounts: { '/': borrowed } })
		try {
			const read = await readonly.fs.directory('documents')
			expect(await read.readFile('record', 'utf8')).toBe('EXTERNAL')
			await expect(read.writeFile('record', 'BAD')).rejects.toMatchObject({ code: 'EROFS' })
			await expect(read.mkdir('bad')).rejects.toMatchObject({ code: 'EROFS' })
			await readonly.host.dispose()
			expect(borrowed.attributes.has('readonly')).toBe(false)
			expect(closes).toEqual([prefix])
			const write = await writable.fs.directory('documents', { writable: true })
			await writeFileAtomic(write, 'record', 'BORROWED')
			expect(await write.readFile('record', 'utf8')).toBe('BORROWED')
		} finally {
			await readonly.host.dispose()
			await writable.host.dispose()
			await borrowed.close()
		}
		expect(closes).toEqual([prefix, prefix])
	})
})
