import { createHash } from 'node:crypto'
import { RpcTarget, type RpcStub } from 'capnweb'
import { sourceFiles } from '../shared/source-files.js'
import { createTypstSourceProject, type TypstSourcePatch } from '@pluxel/plugin-typst/source'
import type {
	BodyCandidate,
	BodyCommit,
	BodyEditorAttachment,
	BodyEditorParticipant,
	BodyRead,
	BodySnapshot,
	DocumentInput,
	DocumentTarget,
	InputWrite,
} from '../shared/contracts.js'
import { InputStore } from './inputs.js'
import { DocumentService } from './documents.js'
import { rpcError } from '../rpc/errors.js'

function revision(sourceRevision: string, input: DocumentInput) {
	const content = JSON.stringify(
		[sourceRevision, input.data, input.editor],
		(_key, value: unknown) =>
			value && typeof value === 'object' && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: value,
	)
	return createHash('sha256').update(content).digest('hex')
}

class Attachment extends RpcTarget implements BodyEditorAttachment {
	constructor(private readonly release: () => void) {
		super()
	}
	async close() {
		this.release()
	}
	[Symbol.dispose]() {
		this.release()
	}
}

/** One body operation path for agent tools, external clients and active desktop drafts. */
export class BodyService {
	private readonly editors = new Map<string, RpcStub<BodyEditorParticipant>>()
	private readonly pending = new Map<string, Promise<unknown>>()
	private readonly writes = new Map<string, Promise<unknown>>()
	constructor(
		private readonly inputs: InputStore,
		private readonly documents: DocumentService,
	) {}

	attach(projectId: string, participant: RpcStub<BodyEditorParticipant>): BodyEditorAttachment {
		if (this.editors.has(projectId))
			throw rpcError('BUSY', 'This project already has an attached editor')
		const owned = participant.dup()
		this.editors.set(projectId, owned)
		const release = () => {
			if (this.editors.get(projectId) !== owned) return
			this.editors.delete(projectId)
			owned[Symbol.dispose]()
		}
		owned.onRpcBroken(release)
		return new Attachment(release)
	}
	close() {
		for (const editor of this.editors.values()) editor[Symbol.dispose]()
		this.editors.clear()
	}

	setInput(input: InputWrite): Promise<DocumentInput> {
		return this.write(input, () => this.persist(input))
	}
	private async persist(
		input: InputWrite,
		expectedSourceRevision?: string,
	): Promise<DocumentInput> {
		await this.documents.validateInput(input, expectedSourceRevision)
		return this.inputs.set(input.projectId, input.entry, input)
	}
	private async write<T>(target: DocumentTarget, action: () => Promise<T>): Promise<T> {
		const key = JSON.stringify([target.projectId, target.entry])
		const work = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(action)
		this.writes.set(key, work)
		try {
			return await work
		} finally {
			if (this.writes.get(key) === work) this.writes.delete(key)
		}
	}

	private async operate<T>(target: DocumentTarget, action: () => Promise<T>): Promise<T> {
		const key = JSON.stringify([target.projectId, target.entry])
		if (this.pending.has(key)) throw rpcError('BUSY', 'Another body operation is in progress')
		const work = Promise.resolve().then(action)
		this.pending.set(key, work)
		try {
			return await work
		} finally {
			this.pending.delete(key)
		}
	}

	private async capture(target: DocumentTarget) {
		const participant = this.editors.get(target.projectId)
		// A broken participant is an error, never permission to use an older saved draft.
		const captured = participant && (await participant.capture({ entry: target.entry }))
		let finished = false
		const finish = async (commit?: Parameters<BodyEditorParticipant['finish']>[0]['commit']) => {
			if (finished || !captured || !participant) return
			finished = true
			try {
				await participant.finish({
					entry: target.entry,
					lease: captured.lease,
					...(commit ? { commit } : {}),
				})
			} catch (cause) {
				// Serialization or callback rejection can leave the connection alive and the
				// editor paused. Release that same lease without resubmitting the commit.
				if (commit)
					await participant.finish({ entry: target.entry, lease: captured.lease }).catch(() => {})
				throw cause
			}
		}
		try {
			const description = await this.documents.describeDocument(target)
			if (!description.editor)
				throw rpcError('EDITOR_NOT_CONFIGURED', 'This report has no editable body')
			let input = captured?.input ?? (await this.inputs.get(target.projectId, target.entry))
			const data = await this.documents.validateInput(
				{ ...target, ...input },
				description.sourceRevision,
			)
			if (data === undefined)
				throw rpcError('EDITOR_NOT_CONFIGURED', 'This report has no editable body')
			return {
				input,
				description,
				data,
				finish,
				attached: !!captured,
				clientRevision: captured?.clientRevision ?? 0,
				baseRevision: revision(description.sourceRevision, input),
			}
		} catch (cause) {
			await finish().catch(() => {})
			throw cause
		}
	}

	read(input: BodyRead): Promise<BodySnapshot> {
		return this.operate(input, async () => {
			const snapshot = await this.capture(input)
			try {
				const definitions = snapshot.description.editor!.sources.filter(
					(source) => !input.path || source.path === input.path,
				)
				if (definitions.length === 0) throw rpcError('READ_ONLY', 'Unknown editable source path')
				if (input.range && !input.path) throw rpcError('INVALID_INPUT', 'A range requires path')
				const files = definitions.map((definition) => {
					const source = snapshot.input.editor!.files[definition.path]!
					const bytes = new TextEncoder().encode(source)
					if (input.range) {
						const { from, to } = input.range
						if (
							!Number.isInteger(from) ||
							!Number.isInteger(to) ||
							from < 0 ||
							to < from ||
							to > bytes.length
						)
							throw rpcError('INVALID_INPUT', 'Invalid UTF-8 source range')
						try {
							new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, from))
							new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, to))
						} catch {
							throw rpcError('INVALID_INPUT', 'Source range splits a UTF-8 character')
						}
					}
					return {
						path: definition.path,
						label: definition.label ?? definition.path,
						source: input.range
							? new TextDecoder('utf-8', { fatal: true }).decode(
									bytes.slice(input.range.from, input.range.to),
								)
							: source,
						range: input.range,
					}
				})
				return {
					...input,
					baseRevision: snapshot.baseRevision,
					sourceRevision: snapshot.description.sourceRevision,
					files,
				}
			} finally {
				await snapshot.finish()
			}
		})
	}

	apply(input: BodyCandidate): Promise<BodyCommit> {
		return this.operate(input, async () => {
			const snapshot = await this.capture(input)
			try {
				return await this.write(input, async () => {
					if (input.baseRevision !== snapshot.baseRevision)
						throw rpcError(
							'STALE_CANDIDATE',
							'The body, data or source changed; read_body again before applying',
						)
					const draft = snapshot.input.editor!
					const source = draft.files[input.path]
					if (source === undefined) throw rpcError('NOT_FOUND', 'Unknown source file')
					const project = createTypstSourceProject({
						files: sourceFiles(snapshot.input),
						writablePaths: snapshot.description.editor!.sources.map(
							(definition) => definition.path,
						),
						components: snapshot.description.editor!.components,
					})
					const patches: TypstSourcePatch[] = [
						{
							path: input.path,
							from: input.range?.from ?? 0,
							to: input.range?.to ?? new TextEncoder().encode(source).length,
							text: input.source,
						},
					]
					const applied = project.apply({ baseRevision: project.revision, patches })
					if (!applied.ok)
						throw Object.assign(
							new Error(applied.issues.map((issue) => issue.message).join('; ')),
							{ code: applied.issues[0]?.code ?? 'INVALID_INPUT', issues: applied.issues },
						)
					const nextFiles = Object.fromEntries(
						Object.entries(applied.value.files).filter(
							(entry): entry is [string, string] => typeof entry[1] === 'string',
						),
					)
					const saved = await this.persist(
						{
							projectId: input.projectId,
							entry: input.entry,
							data: snapshot.input.data,
							editor: {
								files: nextFiles,
							},
							expectedVersion: snapshot.input.storageVersion,
						},
						snapshot.description.sourceRevision,
					)
					const receipt: BodyCommit = {
						projectId: input.projectId,
						entry: input.entry,
						input: saved,
						baseRevision: revision(saved.storageVersion!, saved),
						editorStatus: snapshot.attached ? 'applied' : 'headless',
					}
					let preview
					try {
						receipt.compile = await this.documents.compile({
							projectId: input.projectId,
							entry: input.entry,
							data: saved.data,
							editor: saved.editor,
							clientRevision: snapshot.clientRevision + 1,
						})
						preview = await this.documents.getPreview(receipt.compile)
					} catch (cause) {
						receipt.previewError = cause instanceof Error ? cause.message : String(cause)
					}
					try {
						await snapshot.finish({
							input: saved,
							patches,
							data: snapshot.data,
							compile: receipt.compile,
							preview,
							previewError: receipt.previewError,
						})
					} catch (cause) {
						receipt.editorStatus = 'disconnected'
						receipt.editorError = cause instanceof Error ? cause.message : String(cause)
					}
					return receipt
				})
			} finally {
				await snapshot.finish()
			}
		})
	}
}
