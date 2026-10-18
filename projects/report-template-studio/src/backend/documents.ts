import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FontsPlugin, FontRegistration } from '@pluxel/plugin-fonts'
import type { TypstPlugin, TypstSession, TypstCompiled, TypstPreview } from '@pluxel/plugin-typst'
import type {
	CompileRequest,
	CompileResult,
	DocumentDescription,
	DocumentTarget,
	PageArtifact,
	PdfArtifact,
	PreviewResult,
	RenderPageRequest,
	RevisionTarget,
	WorkspaceSnapshot,
} from '../shared/contracts.js'
import { ArtifactStore } from './artifacts.js'
import { TemplateCompiler } from './compiler.js'
import { inputData } from './inputs.js'
import { pathName, reportEntry } from './storage-validation.js'
import { WorkspaceStore } from './store.js'
import type { RuntimeOperation } from './template-runtime.js'

/** The application binds the same session/queue budgets to official TypstConfig. */
export const DOCUMENT_POLICY = Object.freeze({
	maxSessions: 4,
	maxQueuedUpdates: 8,
	deadlineMs: 30_000,
})

type Snapshot = {
	root: string
	document: WorkspaceSnapshot
	fontPaths: string[]
	fonts: string
	borrowers: number
	cached: boolean
	cleaning?: Promise<void>
}
type CurrentDocument = {
	result: CompileResult
	preview: TypstPreview
	fonts: string
	sourceVersions: Record<string, string>
}
type Job = { run(): Promise<void>; cancel(): void }
type DocumentRecord = {
	target: DocumentTarget
	compiler: TemplateCompiler
	ready: Promise<void>
	closing?: Promise<void>
	session?: TypstSession
	templateRevision?: string
	template?: string
	fonts?: string
	current?: CurrentDocument
	queue: Job[]
	active: boolean
	pending: Set<Promise<unknown>>
	lastUsed: number
}

function failure(code: string, message: string) {
	return Object.assign(new Error(message), { code })
}
function errorCode(error: unknown) {
	return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}
function target(input: DocumentTarget): DocumentTarget {
	if (
		!input ||
		typeof input !== 'object' ||
		typeof input.projectId !== 'string' ||
		!input.projectId ||
		input.projectId.length > 160 ||
		typeof input.entry !== 'string'
	)
		throw failure('INVALID_INPUT', 'projectId and entry are required')
	let entry: string
	try {
		entry = pathName(input.entry)
	} catch (cause) {
		throw Object.assign(new Error('entry must be a workspace-relative POSIX path', { cause }), {
			code: 'INVALID_INPUT',
		})
	}
	if (!reportEntry(entry)) throw failure('INVALID_INPUT', 'entry must be folder/folder.ts')
	return { projectId: input.projectId, entry }
}
function revisionTarget(input: RevisionTarget): RevisionTarget {
	const document = target(input)
	if (typeof input.revision !== 'string' || !input.revision || input.revision.length > 160)
		throw failure('INVALID_INPUT', 'revision is required')
	return { ...document, revision: input.revision }
}

/** One retained native document and constrained evaluator per normalized document identity. */
export class DocumentService {
	private readonly records = new Map<string, DocumentRecord>()
	private readonly snapshots = new Map<string, Snapshot>()
	private readonly allSnapshots = new Set<Snapshot>()
	private readonly operations = new Set<Promise<unknown>>()
	private readonly removing = new Set<string>()
	private readonly shutdown = new AbortController()
	private fontQueue: Promise<unknown> = Promise.resolve()
	private access = 0
	private closed = false
	private closing?: Promise<void>
	constructor(
		private readonly store: WorkspaceStore,
		private readonly fonts: FontsPlugin,
		private readonly typst: TypstPlugin,
		private readonly artifacts: ArtifactStore,
	) {}

	async compile(input: CompileRequest): Promise<CompileResult> {
		const started = performance.now()
		const document = target(input)
		const data = inputData(input.data)
		return this.operate(document, true, async (record, options) => {
			const snapshot = await this.borrowSnapshot(document.projectId, options)
			try {
				const evaluated = await record.compiler.evaluate(
					snapshot.document,
					document.entry,
					data,
					options,
				)
				const fonts = await this.fontSignature(snapshot, options)
				if (record.session && record.fonts !== fonts) {
					this.typst.ctx.logger.info('Studio document fonts changed; rebuilding session', {
						...document,
					})
					await this.releaseSession(record)
				}
				if (!record.session) await this.openSession(record, snapshot, evaluated.template, options)
				await this.assertSnapshot(snapshot, options)
				let compiled: TypstCompiled
				try {
					compiled = await record.session!.update({
						files: evaluated.files,
						...(record.templateRevision === snapshot.document.revision &&
						record.template === evaluated.template
							? {}
							: {
									template: { root: snapshot.root, entry: evaluated.template },
								}),
						signal: options.signal,
						timeoutMs: this.remaining(options),
					})
				} catch (error) {
					if (errorCode(error) === 'COMPILE_FAILED') {
						// A failed layout consumed the template replacement but retained the old document.
						record.templateRevision = snapshot.document.revision
						record.template = evaluated.template
					} else {
						record.templateRevision = undefined
						if (this.fatalNativeFailure(error, options)) await this.releaseSession(record)
					}
					throw error
				}
				// Native success already replaced the retained document. Never leave the old
				// public revision readable if any following publication check fails.
				record.current = undefined
				record.templateRevision = snapshot.document.revision
				record.template = evaluated.template
				await this.assertSnapshot(snapshot, options)
				if ((await this.fontSignature(snapshot, options)) !== record.fonts)
					throw failure(
						'REVISION_CONFLICT',
						'Fonts changed while compiling; compile explicitly again',
					)
				const result: CompileResult = {
					...document,
					name: evaluated.name,
					template: evaluated.template,
					revision: randomUUID(),
					sourceRevision: snapshot.document.revision,
					data: evaluated.data,
					pageCount: compiled.preview.navigation.pages.length,
					pages: compiled.preview.navigation.pages,
					outline: compiled.preview.navigation.outline,
					diagnostics: compiled.diagnostics,
					elapsedMs: performance.now() - started,
				}
				const receipt = structuredClone(result)
				const sourceVersions = Object.fromEntries(
					Object.entries(snapshot.document.files).map(([path, source]) => [
						path,
						createHash('sha256').update(source).digest('hex'),
					]),
				)
				this.remaining(options)
				record.current = {
					result,
					preview: compiled.preview,
					fonts: record.fonts!,
					sourceVersions,
				}
				return receipt
			} finally {
				await this.releaseSnapshot(snapshot)
			}
		})
	}

	async describeDocument(input: DocumentTarget): Promise<DocumentDescription> {
		const document = target(input)
		return this.operate(document, true, async (record, options) => {
			const snapshot = await this.borrowSnapshot(document.projectId, options)
			try {
				const described = await record.compiler.describe(snapshot.document, document.entry, options)
				await this.assertSnapshot(snapshot, options)
				return { ...document, ...described, sourceRevision: snapshot.document.revision }
			} finally {
				await this.releaseSnapshot(snapshot)
			}
		})
	}

	async getPreview(input: RevisionTarget): Promise<PreviewResult> {
		const request = revisionTarget(input)
		return this.operate(request, false, async (record, options) => {
			const current = await this.current(record, request.revision, options)
			const result = structuredClone({
				...request,
				sourceRevision: current.result.sourceRevision,
				sourceVersions: current.sourceVersions,
				preview: current.preview,
			})
			await this.assertCurrent(record, current, options)
			return result
		})
	}

	async renderPage(input: RenderPageRequest): Promise<PageArtifact> {
		const request = {
			...revisionTarget(input),
			page: input.page,
			...(input.scale === undefined ? {} : { scale: input.scale }),
			...(input.region === undefined
				? {}
				: {
						region: input.region && {
							x: input.region.x,
							y: input.region.y,
							width: input.region.width,
							height: input.region.height,
						},
					}),
		}
		return this.operate(request, false, async (record, options) => {
			const current = await this.current(record, request.revision, options)
			let image
			try {
				image = await record.session!.renderPage({
					...request,
					revision: current.preview.revision,
					signal: options.signal,
					timeoutMs: this.remaining(options),
				})
			} catch (error) {
				if (this.fatalNativeFailure(error, options)) await this.releaseSession(record)
				throw error
			}
			const sources = new Map<string, { path: string; fromLine: number; toLine: number }>()
			for (const point of current.preview.navigation.points) {
				if (
					point.page !== image.page ||
					point.x + point.width < image.region.x ||
					point.y + point.height < image.region.y ||
					point.x > image.region.x + image.region.width ||
					point.y > image.region.y + image.region.height
				)
					continue
				const range = sources.get(point.path)
				if (range) {
					range.fromLine = Math.min(range.fromLine, point.line)
					range.toLine = Math.max(range.toLine, point.endLine)
				} else
					sources.set(point.path, { path: point.path, fromLine: point.line, toLine: point.endLine })
			}
			return this.artifacts.publish<PageArtifact>(
				{
					projectId: request.projectId,
					entry: request.entry,
					revision: request.revision,
					kind: 'png',
					mimeType: 'image/png',
					page: image.page,
					width: image.width,
					height: image.height,
					region: image.region,
					headings: current.preview.navigation.outline.filter((item) => item.page === image.page),
					sources: [...sources.values()],
				},
				image.data,
				() => this.assertCurrent(record, current, options),
			)
		})
	}

	async exportPdf(input: RevisionTarget): Promise<PdfArtifact> {
		const request = revisionTarget(input)
		return this.operate(request, false, async (record, options) => {
			const current = await this.current(record, request.revision, options)
			let bytes
			try {
				bytes = await record.session!.exportPdf(current.preview.revision)
			} catch (error) {
				if (this.fatalNativeFailure(error, options)) await this.releaseSession(record)
				throw error
			}
			return this.artifacts.publish<PdfArtifact>(
				{ ...request, kind: 'pdf', mimeType: 'application/pdf' },
				bytes,
				() => this.assertCurrent(record, current, options),
			)
		})
	}

	private operate<T>(
		document: DocumentTarget,
		create: boolean,
		execute: (record: DocumentRecord, options: RuntimeOperation) => Promise<T>,
	): Promise<T> {
		if (this.closed) return Promise.reject(failure('CLOSED', 'Studio documents are closed'))
		const timeout = new AbortController()
		const deadline = Date.now() + DOCUMENT_POLICY.deadlineMs
		const timer = setTimeout(
			() =>
				timeout.abort(
					Object.assign(new Error('Studio document operation timed out'), {
						name: 'TimeoutError',
						code: 'DEADLINE_EXCEEDED',
					}),
				),
			DOCUMENT_POLICY.deadlineMs,
		)
		const options = { deadline, signal: AbortSignal.any([this.shutdown.signal, timeout.signal]) }
		const operation = (async () => {
			try {
				options.signal.throwIfAborted()
				if (this.removing.has(document.projectId))
					throw failure('CLOSED', 'Project documents are being removed')
				// WorkspaceStore IDs and pathName-validated entries are canonical identities.
				// Reserve the bounded document slot before any asynchronous store scan.
				const canonical = document
				const key = JSON.stringify([canonical.projectId, canonical.entry])
				let record = this.records.get(key)
				if (!record && !create)
					throw failure(
						'REVISION_CONFLICT',
						'Document revision is no longer retained; compile explicitly again',
					)
				if (!record) {
					let previous: DocumentRecord | undefined
					if (this.records.size >= DOCUMENT_POLICY.maxSessions) {
						const idle = [...this.records.entries()]
							.filter(([, value]) => !value.active && value.pending.size === 0)
							.sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]
						if (!idle) throw failure('BUSY', 'All Studio document records are busy')
						this.records.delete(idle[0])
						previous = idle[1]
					}
					record = {
						target: canonical,
						compiler: new TemplateCompiler(),
						ready: previous ? this.closeRecord(previous) : Promise.resolve(),
						active: false,
						queue: [],
						pending: new Set(),
						lastUsed: ++this.access,
					}
					this.records.set(key, record)
				}
				return await this.enqueue(record, options, () => execute(record!, options))
			} catch (error) {
				if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, document)
				throw error
			} finally {
				clearTimeout(timer)
			}
		})()
		this.operations.add(operation)
		void operation.then(
			() => this.operations.delete(operation),
			() => this.operations.delete(operation),
		)
		return operation
	}
	private enqueue<T>(
		record: DocumentRecord,
		options: RuntimeOperation,
		execute: () => Promise<T>,
	): Promise<T> {
		if (record.queue.length >= DOCUMENT_POLICY.maxQueuedUpdates)
			return Promise.reject(failure('BUSY', 'Studio document operation queue is full'))
		let resolve!: (value: T) => void
		let reject!: (cause: unknown) => void
		const result = new Promise<T>((yes, no) => {
			resolve = yes
			reject = no
		})
		const job: Job = {
			run: async () => {
				options.signal!.removeEventListener('abort', job.cancel)
				try {
					await record.ready
					this.remaining(options)
					resolve(await execute())
				} catch (cause) {
					reject(cause)
				}
			},
			cancel: () => {
				const index = record.queue.indexOf(job)
				if (index < 0) return
				record.queue.splice(index, 1)
				options.signal!.removeEventListener('abort', job.cancel)
				reject(options.signal!.reason)
			},
		}
		record.lastUsed = ++this.access
		record.queue.push(job)
		record.pending.add(result)
		void result.then(
			() => record.pending.delete(result),
			() => record.pending.delete(result),
		)
		options.signal!.addEventListener('abort', job.cancel, { once: true })
		if (options.signal!.aborted) job.cancel()
		this.drain(record)
		return result
	}
	private drain(record: DocumentRecord) {
		if (record.active) return
		const job = record.queue.shift()
		if (!job) return
		record.active = true
		void job.run().finally(() => {
			record.active = false
			record.lastUsed = ++this.access
			this.drain(record)
		})
	}
	private remaining(options: RuntimeOperation) {
		options.signal?.throwIfAborted()
		const remaining = Math.ceil(options.deadline! - Date.now())
		if (remaining <= 0) throw failure('DEADLINE_EXCEEDED', 'Studio document operation timed out')
		return remaining
	}
	private async borrowSnapshot(projectId: string, options: RuntimeOperation): Promise<Snapshot> {
		const before = await this.store.snapshot(projectId)
		this.remaining(options)
		const previous = this.snapshots.get(projectId)
		if (previous?.document.revision === before.revision) {
			previous.borrowers++
			this.snapshots.delete(projectId)
			this.snapshots.set(projectId, previous)
			return previous
		}
		const root = await mkdtemp(join(tmpdir(), 'pluxel-studio-'))
		let installed: Snapshot | undefined
		try {
			const document = await this.store.materialize(projectId, root)
			const after = await this.store.snapshot(projectId)
			if (document.revision !== before.revision || after.revision !== document.revision)
				throw failure(
					'REVISION_CONFLICT',
					'Workspace changed while its source snapshot was being copied',
				)
			const fontPaths = document.assets
				.filter(
					(item) =>
						/\.(ttf|otf)$/i.test(item.path) &&
						document.config.fonts.some(
							(font) => item.path === font || item.path.startsWith(font.replace(/\/$/, '') + '/'),
						),
				)
				.map((item) => item.path)
				.sort()
			const hash = createHash('sha256')
			for (const path of fontPaths) {
				this.remaining(options)
				hash.update(path).update(await readFile(join(root, path)))
			}
			this.remaining(options)
			const snapshot: Snapshot = {
				root,
				document,
				fontPaths,
				fonts: hash.digest('hex'),
				borrowers: 1,
				cached: true,
			}
			installed = snapshot
			this.allSnapshots.add(snapshot)
			const replaced = this.snapshots.get(projectId)
			this.snapshots.delete(projectId)
			this.snapshots.set(projectId, snapshot)
			if (replaced) {
				replaced.cached = false
				await this.cleanSnapshot(replaced)
			}
			while (this.snapshots.size > DOCUMENT_POLICY.maxSessions) {
				const [id, oldest] = this.snapshots.entries().next().value!
				this.snapshots.delete(id)
				oldest.cached = false
				await this.cleanSnapshot(oldest)
			}
			return snapshot
		} catch (error) {
			if (installed) await this.releaseSnapshot(installed)
			else await rm(root, { recursive: true, force: true })
			throw error
		}
	}
	private async releaseSnapshot(snapshot: Snapshot) {
		snapshot.borrowers--
		await this.cleanSnapshot(snapshot)
	}
	private async cleanSnapshot(snapshot: Snapshot) {
		if (snapshot.cached || snapshot.borrowers > 0) return
		await (snapshot.cleaning ??= rm(snapshot.root, { recursive: true, force: true }).then(() => {
			this.allSnapshots.delete(snapshot)
			return undefined
		}))
	}
	private async assertSnapshot(snapshot: Snapshot, options: RuntimeOperation) {
		this.remaining(options)
		const current = await this.store.snapshot(snapshot.document.project.id)
		if (current.revision !== snapshot.document.revision)
			throw failure('REVISION_CONFLICT', 'Workspace changed; compile explicitly again')
		this.remaining(options)
	}
	private withFonts<T>(options: RuntimeOperation, execute: () => Promise<T>): Promise<T> {
		const task = this.fontQueue.then(() => {
			this.remaining(options)
			return execute()
		})
		this.fontQueue = task.catch(() => {})
		return task
	}
	private portableSignature() {
		return JSON.stringify(
			this.fonts.portableFonts.fonts.map((font) => [font.id, font.family, font.byteLength]),
		)
	}
	private fontSignature(snapshot: Pick<Snapshot, 'fonts'>, options: RuntimeOperation) {
		return this.withFonts(options, async () =>
			JSON.stringify([snapshot.fonts, this.portableSignature()]),
		)
	}
	private async openSession(
		record: DocumentRecord,
		snapshot: Snapshot,
		template: string,
		options: RuntimeOperation,
	) {
		await this.withFonts(options, async () => {
			const baseline = this.portableSignature()
			const registrations: FontRegistration[] = []
			let session: TypstSession | undefined
			let cause: unknown
			try {
				for (const path of snapshot.fontPaths)
					registrations.push(
						await this.fonts.registerFromPath({
							path: join(snapshot.root, path),
							signal: options.signal,
						}),
					)
				session = await this.typst.open(
					{ root: snapshot.root, entry: template },
					{ signal: options.signal, timeoutMs: this.remaining(options) },
				)
			} catch (error) {
				cause = error
			}
			const failures: unknown[] = cause === undefined ? [] : [cause]
			for (const registration of registrations.toReversed()) {
				try {
					registration.dispose()
				} catch (error) {
					failures.push(error)
				}
			}
			if (failures.length > 0) {
				try {
					await session?.dispose()
				} catch (error) {
					failures.push(error)
				}
				if (failures.length === 1) throw failures[0]
				throw new AggregateError(failures, 'Studio font snapshot/open cleanup failed')
			}
			if (this.portableSignature() !== baseline) {
				await session!.dispose()
				throw failure('REVISION_CONFLICT', 'Font registry changed while opening the document')
			}
			record.session = session
			record.fonts = JSON.stringify([snapshot.fonts, baseline])
			record.templateRevision = snapshot.document.revision
			record.template = template
			this.typst.ctx.logger.info('Studio document session opened', {
				...record.target,
				sessionId: session!.id,
			})
		})
	}
	private fatalNativeFailure(error: unknown, options: RuntimeOperation) {
		return (
			options.signal?.aborted ||
			!['COMPILE_FAILED', 'INVALID_INPUT', 'LIMIT_EXCEEDED', 'BUSY', 'STALE_REVISION'].includes(
				String(errorCode(error)),
			)
		)
	}
	private async releaseSession(record: DocumentRecord) {
		const session = record.session
		record.session = undefined
		record.current = undefined
		record.fonts = undefined
		record.templateRevision = undefined
		record.template = undefined
		await session?.dispose()
	}
	private async current(record: DocumentRecord, revision: string, options: RuntimeOperation) {
		const current = record.current
		if (!record.session || !current || current.result.revision !== revision)
			throw failure(
				'REVISION_CONFLICT',
				'Document revision is no longer retained; compile explicitly again',
			)
		await this.assertCurrent(record, current, options)
		return current
	}
	private async assertCurrent(
		record: DocumentRecord,
		current: CurrentDocument,
		options: RuntimeOperation,
	) {
		this.remaining(options)
		const source = await this.store.snapshot(record.target.projectId)
		if (
			record.current !== current ||
			!record.session ||
			source.revision !== current.result.sourceRevision
		)
			throw failure(
				'REVISION_CONFLICT',
				'Document source revision changed; compile explicitly again',
			)
		const workspaceFonts = JSON.parse(current.fonts)[0] as string
		if ((await this.fontSignature({ fonts: workspaceFonts }, options)) !== current.fonts)
			throw failure('REVISION_CONFLICT', 'Document fonts changed; compile explicitly again')
		this.remaining(options)
	}
	private closeRecord(record: DocumentRecord): Promise<void> {
		return (record.closing ??= (async () => {
			await Promise.allSettled(record.pending)
			const results = await Promise.allSettled([
				record.ready,
				record.compiler.close(),
				this.releaseSession(record),
			])
			const failed = results.filter((result) => result.status === 'rejected')
			if (failed.length > 0)
				throw new AggregateError(
					failed.map((result) => result.reason),
					'Studio document record failed to close',
				)
		})())
	}
	/** Keep admission withdrawn until the owning workspace removal has committed. */
	async remove(projectId: string, forget: () => Promise<unknown>) {
		if (this.removing.has(projectId))
			throw failure('BUSY', 'Project documents are already being removed')
		this.removing.add(projectId)
		try {
			const records = [...this.records.entries()].filter(
				([, record]) => record.target.projectId === projectId,
			)
			const results = await Promise.allSettled(
				records.map(([, record]) => this.closeRecord(record)),
			)
			for (const [key] of records) this.records.delete(key)
			const snapshot = this.snapshots.get(projectId)
			this.snapshots.delete(projectId)
			if (snapshot) {
				snapshot.cached = false
				await this.cleanSnapshot(snapshot)
			}
			const failed = results.filter((result) => result.status === 'rejected')
			if (failed.length > 0)
				throw new AggregateError(
					failed.map((result) => result.reason),
					'Project document cleanup failed',
				)
			await forget()
		} finally {
			this.removing.delete(projectId)
		}
	}
	close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		this.shutdown.abort(failure('CLOSED', 'Studio documents are closed'))
		return (this.closing = (async () => {
			await Promise.allSettled(this.operations)
			const results = await Promise.allSettled(
				[...this.records.values()].map((record) => this.closeRecord(record)),
			)
			this.records.clear()
			this.snapshots.clear()
			for (const snapshot of this.allSnapshots) snapshot.cached = false
			const snapshotResults = await Promise.allSettled(
				[...this.allSnapshots].map((snapshot) => this.cleanSnapshot(snapshot)),
			)
			const failed = [...results, ...snapshotResults].filter(
				(result) => result.status === 'rejected',
			)
			if (failed.length > 0)
				throw new AggregateError(
					failed.map((result) => result.reason),
					'Studio documents failed to close',
				)
		})())
	}
}
