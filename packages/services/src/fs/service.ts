import type { RootContext } from '@pluxel/core'
import type { HostDocumentStorage } from '@pluxel/host'
import {
	bindContext,
	checkOptions,
	InMemory,
	Passthrough,
	resolveMountConfig,
	vfs,
	type BackendConfiguration,
	type Backend,
	type BoundContext,
	type FileSystem,
} from '@zenfs/core'
import type { IndexedDB } from '@zenfs/dom'
import { withErrno } from 'kerium'
import { writeFileAtomic } from './atomic'

export type FsPromises = BoundContext['fs']['promises']

/** Select a fresh backend per Host; opened filesystems and nested mount graphs are not accepted. */
export type FsServiceConfig =
	| BackendConfiguration<typeof InMemory>
	| BackendConfiguration<typeof Passthrough>
	| BackendConfiguration<typeof IndexedDB>

export interface FsRequirement {
	durable?: boolean
	writable?: boolean
}

function validateDirectory(path: string): void {
	if (
		typeof path !== 'string' ||
		path.length === 0 ||
		path.includes('\\') ||
		path.includes('\0') ||
		/^[A-Za-z]:/.test(path) ||
		path.split('/').some((part) => part === '' || part === '.' || part === '..')
	)
		throw new TypeError(`[services.fs] expected a canonical relative directory: ${path}`)
}

function missing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

/** Validate the declaration without opening a backend or reading Host configuration. */
export function snapshotFsConfig(config: FsServiceConfig): FsServiceConfig {
	if (!config || typeof config !== 'object' || Array.isArray(config) || !config.backend)
		throw new TypeError(
			'[services.fs] provide an InMemory, Passthrough or IndexedDB backend configuration',
		)
	const backend = config.backend
	if (backend !== InMemory && backend !== Passthrough && backend.name !== 'IndexedDB')
		throw new TypeError(
			'[services.fs] unsupported backend; import the selected backend from @pluxel/services/fs or /fs/browser',
		)
	if (config.readOnly !== undefined && typeof config.readOnly !== 'boolean')
		throw new TypeError('[services.fs] readOnly must be a boolean')
	if (config.disableAsyncCache !== undefined && typeof config.disableAsyncCache !== 'boolean')
		throw new TypeError('[services.fs] disableAsyncCache must be a boolean')
	if (config.caseFold !== undefined && config.caseFold !== 'upper' && config.caseFold !== 'lower')
		throw new TypeError('[services.fs] caseFold must be upper or lower')
	for (const key of Object.keys(config)) {
		if (
			!['backend', 'readOnly', 'disableAsyncCache', 'caseFold'].includes(key) &&
			!(key in backend.options)
		)
			throw new TypeError(`[services.fs] unknown backend option: ${key}`)
	}
	checkOptions(backend, { ...config })
	if (
		backend === Passthrough &&
		(!(config as BackendConfiguration<typeof Passthrough>).prefix ||
			typeof (config as BackendConfiguration<typeof Passthrough>).prefix !== 'string')
	)
		throw new TypeError('[services.fs] Passthrough requires a nonempty prefix')
	return Object.freeze({ ...config })
}

/** One Host owns preparation, bound directories and final backend closure. */
export class FsService {
	readonly durable: boolean
	readonly readOnly: boolean
	private readyPromise?: Promise<BoundContext>
	private backing?: FileSystem
	private context?: BoundContext
	private readonly directories = new Map<string, Promise<BoundContext>>()
	private closed = false
	private disposal?: Promise<void>

	constructor(
		root: RootContext,
		private readonly config: FsServiceConfig,
	) {
		this.durable = config.backend !== InMemory
		this.readOnly = config.readOnly === true
		root.effects.defer(() => this.dispose(), { tag: 'Fs', phase: 'final' })
	}

	async ready(requirement?: FsRequirement): Promise<void> {
		this.assertOpen(requirement)
		this.readyPromise ??= this.open()
		await this.readyPromise
		this.assertOpen(requirement)
	}

	/** Borrow a fixed directory. Writable directories are created lazily; readonly reads never create. */
	async directory(path: string, requirement?: FsRequirement): Promise<FsPromises> {
		validateDirectory(path)
		await this.ready(requirement)
		let directory = this.directories.get(path)
		if (!directory) {
			directory = this.bindDirectory(path)
			this.directories.set(path, directory)
		}
		const context = await directory
		this.assertOpen(requirement)
		return context.fs.promises
	}

	/** Pure, borrowed Host document adapter; its first async operation prepares the same backend. */
	documents(path: string): HostDocumentStorage {
		validateDirectory(path)
		return {
			getText: async (key) => {
				validateDirectory(key)
				const fs = await this.directory(path)
				try {
					return await fs.readFile(key, 'utf8')
				} catch (error) {
					if (missing(error)) return undefined
					throw error
				}
			},
			put: async (key, text) => {
				validateDirectory(key)
				await writeFileAtomic(await this.directory(path, { writable: true }), key, text)
			},
			stat: async (key) => {
				validateDirectory(key)
				const fs = await this.directory(path)
				try {
					return await fs.stat(key)
				} catch (error) {
					if (missing(error)) return undefined
					throw error
				}
			},
		}
	}

	private assertOpen(requirement?: FsRequirement): void {
		if (this.closed) throw withErrno('EBADF', 'Host filesystem is closed')
		if (requirement !== undefined) {
			if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement))
				throw new TypeError('[services.fs] requirement must be an object')
			for (const key of Object.keys(requirement)) {
				if (key !== 'durable' && key !== 'writable')
					throw new TypeError(`[services.fs] unknown requirement: ${key}`)
			}
		}
		for (const key of ['durable', 'writable'] as const) {
			if (requirement?.[key] !== undefined && typeof requirement[key] !== 'boolean')
				throw new TypeError(`[services.fs] requirement.${key} must be a boolean`)
		}
		if (requirement?.durable && !this.durable)
			throw withErrno(
				'ENOTSUP',
				'Durable storage is required; InMemory does not persist across Hosts',
			)
		if (requirement?.writable && this.readOnly)
			throw withErrno('EROFS', 'Writable storage is required; the selected filesystem is readonly')
	}

	private async open(): Promise<BoundContext> {
		const config = { ...this.config }
		if (config.backend !== InMemory && config.backend !== Passthrough) {
			const { IndexedDB } = await import('@zenfs/dom')
			if (config.backend !== IndexedDB)
				throw new TypeError(
					'[services.fs] import IndexedDB from @pluxel/services/fs/browser to use the fixed backend',
				)
		}
		if (config.backend === Passthrough) {
			const native = config as BackendConfiguration<typeof Passthrough>
			if (this.readOnly) {
				const stat = await native.fs.promises.stat(native.prefix)
				if (!stat.isDirectory())
					throw withErrno('ENOTDIR', `Filesystem prefix is not a directory: ${native.prefix}`)
			} else await native.fs.promises.mkdir(native.prefix, { recursive: true })
		}
		this.backing = await resolveMountConfig<Backend>(config)
		this.context = bindContext({ root: '/', pwd: '/', mounts: { '/': this.backing } })
		return this.context
	}

	private async bindDirectory(path: string): Promise<BoundContext> {
		const root = await this.readyPromise!
		if (!this.readOnly) await root.fs.promises.mkdir(path, { recursive: true })
		this.assertOpen()
		return root.bind({ root: `/${path}`, pwd: '/' })
	}

	private dispose(): Promise<void> {
		this.closed = true
		this.disposal ??= (async () => {
			const errors: unknown[] = []
			await this.readyPromise?.catch((): undefined => undefined)
			// Directory preparation is owned here; arbitrary unawaited caller IO is not.
			await Promise.allSettled(this.directories.values())
			if (this.context) {
				try {
					await this.context.dispose()
				} catch (error) {
					errors.push(error)
				}
				try {
					await vfs.umountAsync.call(this.context, '/')
				} catch (error) {
					errors.push(error)
				}
			}
			if (this.backing && 'close' in this.backing && typeof this.backing.close === 'function') {
				try {
					await this.backing.close()
				} catch (error) {
					errors.push(error)
				}
			}
			this.directories.clear()
			if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Host filesystem')
		})()
		return this.disposal
	}
}
