import type { RootContext } from '../context/Context'
import type { HostDocumentStorage } from '../storage/documents'
import type { BoundContext } from '@zenfs/core'
import { withErrno } from 'kerium'
import { FsDocuments } from './documents'
import { FsMounts, type ResolvedFsConfig } from './config'

export { snapshotFsConfig } from './config'
export type { FsConfig } from './config'
export type FsPromises = BoundContext['fs']['promises']

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
		throw new TypeError(`[core.fs] expected a canonical relative directory: ${path}`)
}

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** One Host owns preparation, bound directories and final backend closure. */
export class FsService {
	private readyPromise?: Promise<BoundContext>
	private mounts?: FsMounts
	private readonly directories = new Map<string, Promise<BoundContext>>()
	private readonly documentDirectories = new Map<string, FsDocuments>()
	private closed = false
	private disposal?: Promise<void>

	constructor(
		private readonly root: RootContext,
		private readonly config: ResolvedFsConfig,
	) {
		root.effects.defer(() => this.dispose(), { tag: 'Fs', phase: 'final' })
	}

	async ready(requirement?: FsRequirement): Promise<void> {
		this.assertOpen(requirement)
		this.readyPromise ??= this.open()
		await this.readyPromise
		this.assertOpen(requirement)
		this.assertRequirements('/', requirement)
	}

	/** Borrow a fixed directory. Writable directories are created lazily; readonly reads never create. */
	async directory(path: string, requirement?: FsRequirement): Promise<FsPromises> {
		validateDirectory(path)
		this.assertOpen(requirement)
		await this.ready()
		this.assertRequirements(`/${path}`, requirement)
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
	documents(path: string, maxBytes = MAX_DOCUMENT_BYTES): HostDocumentStorage {
		validateDirectory(path)
		this.assertOpen()
		if (this.disposal) throw withErrno('EBADF', 'Host filesystem is closed')
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
			throw new TypeError('[core.fs] document byte limit must be a positive safe integer')
		let documents = this.documentDirectories.get(path)
		if (!documents) {
			documents = new FsDocuments(
				(requirement) => this.directory(path, requirement),
				maxBytes,
				(error, key) =>
					this.root.logger.error('Cannot observe Host document {path}/{key}', { path, key, error }),
			)
			this.documentDirectories.set(path, documents)
		}
		if (documents.maxBytes !== maxBytes)
			throw new TypeError('[core.fs] a document directory has one fixed byte limit')
		return documents
	}

	private assertOpen(requirement?: FsRequirement): void {
		if (this.closed) throw withErrno('EBADF', 'Host filesystem is closed')
		if (requirement !== undefined) {
			if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement))
				throw new TypeError('[core.fs] requirement must be an object')
			for (const key of Object.keys(requirement)) {
				if (key !== 'durable' && key !== 'writable')
					throw new TypeError(`[core.fs] unknown requirement: ${key}`)
			}
		}
		for (const key of ['durable', 'writable'] as const) {
			if (requirement?.[key] !== undefined && typeof requirement[key] !== 'boolean')
				throw new TypeError(`[core.fs] requirement.${key} must be a boolean`)
		}
	}

	private async open(): Promise<BoundContext> {
		this.mounts = new FsMounts(this.config)
		return this.mounts.open()
	}

	private relevantMounts(path: string) {
		const mounts = [...this.mounts!.context.mounts]
		const parent = mounts
			.filter(([point]) => point === '/' || path === point || path.startsWith(`${point}/`))
			.sort(([a], [b]) => b.length - a.length)[0]!
		return [
			parent,
			...mounts.filter(
				([point]) => point !== parent[0] && (path === '/' || point.startsWith(`${path}/`)),
			),
		]
	}

	private assertRequirements(path: string, requirement?: FsRequirement): void {
		if (!requirement) return
		for (const [point, fs] of this.relevantMounts(path)) {
			if (requirement.durable && !this.config.durableMounts.includes(point))
				throw withErrno(
					'ENOTSUP',
					`Durable storage is required; mount ${point} has no persistence declaration`,
				)
			if (requirement.writable && (fs.attributes.has('readonly') || fs.attributes.has('no_write')))
				throw withErrno('EROFS', `Writable storage is required; mount ${point} is readonly`)
		}
	}

	private async bindDirectory(path: string): Promise<BoundContext> {
		const root = await this.readyPromise!
		const [[, fs]] = this.relevantMounts(`/${path}`)
		if (!fs.attributes.has('readonly') && !fs.attributes.has('no_write'))
			await root.fs.promises.mkdir(path, { recursive: true })
		this.assertOpen()
		return root.bind({ root: `/${path}`, pwd: '/' })
	}

	private dispose(): Promise<void> {
		this.disposal ??= (async () => {
			const errors: unknown[] = []
			const documents = await Promise.allSettled(
				[...this.documentDirectories.values()].map((value) => value.close()),
			)
			for (const result of documents) if (result.status === 'rejected') errors.push(result.reason)
			this.closed = true
			await this.readyPromise?.catch((): undefined => undefined)
			// Directory preparation is owned here; arbitrary unawaited caller IO is not.
			await Promise.allSettled(this.directories.values())
			try {
				await this.mounts?.dispose()
			} catch (error) {
				errors.push(error)
			}
			this.directories.clear()
			this.documentDirectories.clear()
			if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Host filesystem')
		})()
		return this.disposal
	}
}
