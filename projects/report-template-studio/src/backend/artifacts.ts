import { randomUUID } from 'node:crypto'
import { mkdir, lstat, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ArtifactUnion } from '../shared/contracts.js'
import { safePath } from './storage-validation.js'

/** Product retention policy. Internal overrides are used by storage regression tests. */
export const ARTIFACT_POLICY: Readonly<{
	retentionMs: number
	maxBytes: number
	maxFiles: number
}> = Object.freeze({
	retentionMs: 24 * 60 * 60 * 1000,
	maxBytes: 512 * 1024 * 1024,
	maxFiles: 4096,
})
const OWNER = 'report-template-studio-artifact-v1'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const filenames = { png: 'page.png', pdf: 'document.pdf', zip: 'workspace.zip' } as const
export type ArtifactMetadata<T extends ArtifactUnion = ArtifactUnion> = T extends ArtifactUnion
	? Omit<T, 'id' | 'path' | 'byteLength' | 'createdAt' | 'expiresAt'>
	: never

function failure(code: string, message: string) {
	return Object.assign(new Error(message), { code })
}

/** Atomic directory publication makes metadata and immutable content recover together. */
export class ArtifactStore {
	private readonly root: string
	private readonly published = new Map<string, ArtifactUnion>()
	private bytes = 0
	private reservedBytes = 0
	private reservedFiles = 0
	private queue: Promise<unknown> = Promise.resolve()
	private initializing?: Promise<void>
	private closed = false
	private readonly writes = new Set<Promise<unknown>>()
	constructor(
		root: string,
		private readonly policy = ARTIFACT_POLICY,
	) {
		this.root = resolve(root)
	}
	private serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run)
		this.queue = next.catch(() => {})
		return next
	}
	initialize(): Promise<void> {
		return (this.initializing ??= this.serial(async () => {
			await mkdir(await safePath(this.root), { recursive: true, mode: 0o700 })
			for (const name of await readdir(this.root)) {
				const temporary = name.startsWith('.pending-')
				const id = temporary ? name.slice('.pending-'.length) : name
				if (!uuid.test(id)) continue
				const directory = join(this.root, name)
				try {
					const info = await lstat(directory)
					if (!info.isDirectory() || info.isSymbolicLink()) continue
					const members = await readdir(directory)
					if (
						members.some(
							(item) =>
								!['.studio-artifact', 'metadata.json', ...Object.values(filenames)].includes(item),
						)
					)
						continue
					const memberStats = await Promise.all(members.map((item) => lstat(join(directory, item))))
					if (memberStats.some((item) => !item.isFile() || item.isSymbolicLink())) continue
					// Only an owned marker permits cleanup; unknown paths remain untouched.
					if (
						(await readFile(await safePath(join(directory, '.studio-artifact')), 'utf8')) !==
						OWNER + '\n' + id
					)
						continue
					if (temporary) {
						await this.removeOwned(directory)
						continue
					}
					const value: unknown = JSON.parse(
						await readFile(await safePath(join(directory, 'metadata.json')), 'utf8'),
					)
					if (!value || typeof value !== 'object') continue
					const meta = value as ArtifactUnion
					if (
						meta.id !== id ||
						!Object.hasOwn(filenames, meta.kind) ||
						typeof meta.projectId !== 'string' ||
						typeof meta.entry !== 'string' ||
						typeof meta.revision !== 'string' ||
						!Number.isSafeInteger(meta.byteLength) ||
						meta.byteLength < 0 ||
						!Number.isFinite(Date.parse(meta.createdAt)) ||
						!Number.isFinite(Date.parse(meta.expiresAt))
					)
						continue
					const path = join(directory, filenames[meta.kind])
					const file = await lstat(await safePath(path))
					if (!file.isFile() || file.isSymbolicLink() || file.size !== meta.byteLength) continue
					if (Date.parse(meta.expiresAt) <= Date.now()) {
						await this.removeOwned(directory)
						continue
					}
					this.published.set(id, { ...meta, path })
					this.bytes += meta.byteLength
				} catch (error) {
					// Missing/corrupt metadata is not permission to delete foreign files.
					if (
						!(error instanceof SyntaxError) &&
						!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
					)
						throw error
				}
			}
		}))
	}
	private async removeOwned(directory: string) {
		await safePath(directory)
		const directoryName = basename(directory)
		const id = directoryName.startsWith('.pending-')
			? directoryName.slice('.pending-'.length)
			: directoryName
		if (
			!uuid.test(id) ||
			(await readFile(await safePath(join(directory, '.studio-artifact')), 'utf8')) !==
				OWNER + '\n' + id
		)
			throw failure('IO_ERROR', 'Artifact ownership marker changed; cleanup refused')
		for (const name of await readdir(directory)) {
			const info = await lstat(join(directory, name))
			if (
				!['.studio-artifact', 'metadata.json', ...Object.values(filenames)].includes(name) ||
				!info.isFile() ||
				info.isSymbolicLink()
			)
				throw failure('IO_ERROR', 'Artifact directory contains a foreign entry; cleanup refused')
		}
		await rm(directory, { recursive: true })
	}
	private async prune() {
		for (const [id, artifact] of this.published) {
			if (Date.parse(artifact.expiresAt) > Date.now()) continue
			await this.removeOwned(join(this.root, id))
			this.published.delete(id)
			this.bytes -= artifact.byteLength
		}
	}
	publish<T extends ArtifactUnion>(
		metadata: ArtifactMetadata<T>,
		bytes: Uint8Array,
		validate?: () => Promise<void>,
	): Promise<T> {
		if (this.closed) return Promise.reject(failure('CLOSED', 'Artifact store is closed'))
		const writing = this.write(metadata, bytes, validate)
		this.writes.add(writing)
		void writing.finally(() => this.writes.delete(writing)).catch(() => {})
		return writing
	}
	private async write<T extends ArtifactUnion>(
		metadata: ArtifactMetadata<T>,
		content: Uint8Array,
		validate?: () => Promise<void>,
	): Promise<T> {
		await this.initialize()
		if (!(content instanceof Uint8Array))
			throw failure('INVALID_INPUT', 'Artifact content must be bytes')
		const byteLength = content.byteLength
		await this.serial(async () => {
			await this.prune()
			if (
				this.published.size + this.reservedFiles >= this.policy.maxFiles ||
				this.bytes + this.reservedBytes + byteLength > this.policy.maxBytes
			)
				throw failure(
					'LIMIT_EXCEEDED',
					'Artifact storage is full; retained files cannot be removed before expiresAt',
				)
			this.reservedBytes += byteLength
			this.reservedFiles++
		})
		const id = randomUUID()
		const temporary = join(this.root, '.pending-' + id)
		const directory = join(this.root, id)
		let committed = false
		let directoryCreated = false
		let marked = false
		try {
			await mkdir(await safePath(temporary), { mode: 0o700 })
			directoryCreated = true
			await writeFile(join(temporary, '.studio-artifact'), OWNER + '\n' + id, {
				flag: 'wx',
				mode: 0o600,
			})
			marked = true
			const filename = filenames[metadata.kind]
			await writeFile(join(temporary, filename), content, { flag: 'wx', mode: 0o600 })
			// Source consistency is rechecked after the actual disk write, before publication.
			await validate?.()
			const created = Date.now()
			const artifact = structuredClone({
				...metadata,
				id,
				path: join(directory, filename),
				byteLength,
				createdAt: new Date(created).toISOString(),
				expiresAt: new Date(created + this.policy.retentionMs).toISOString(),
			}) as unknown as T
			await writeFile(join(temporary, 'metadata.json'), JSON.stringify(artifact), {
				flag: 'wx',
				mode: 0o600,
			})
			await rename(temporary, directory)
			committed = true
			this.published.set(id, artifact)
			this.bytes += byteLength
			return structuredClone(artifact)
		} catch (error) {
			if (!committed && directoryCreated) {
				try {
					if (marked) await this.removeOwned(temporary)
					else await rmdir(await safePath(temporary))
				} catch (cleanup) {
					throw Object.assign(
						new AggregateError([error, cleanup], 'Artifact publication and cleanup failed', {
							cause: error,
						}),
						{
							code: error && typeof error === 'object' && 'code' in error ? error.code : 'IO_ERROR',
						},
					)
				}
			}
			throw error
		} finally {
			this.reservedBytes -= byteLength
			this.reservedFiles--
		}
	}
	async resolve(id: string): Promise<ArtifactUnion> {
		await this.initialize()
		if (!uuid.test(id)) throw failure('INVALID_INPUT', 'Invalid artifact id')
		const artifact = this.published.get(id)
		if (!artifact || Date.parse(artifact.expiresAt) <= Date.now())
			throw failure('ENOENT', 'Artifact is unavailable or expired')
		const file = await lstat(await safePath(artifact.path))
		if (!file.isFile() || file.isSymbolicLink() || file.size !== artifact.byteLength)
			throw failure('IO_ERROR', 'Artifact file changed or is incomplete')
		return structuredClone(artifact)
	}
	async read(id: string): Promise<Uint8Array> {
		const artifact = await this.resolve(id)
		const bytes = await readFile(await safePath(artifact.path))
		if (bytes.byteLength !== artifact.byteLength)
			throw failure('IO_ERROR', 'Artifact file changed while reading')
		return bytes
	}
	async close() {
		this.closed = true
		await Promise.allSettled(this.writes)
		await this.queue
	}
}
