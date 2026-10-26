import { createHash } from 'node:crypto'
import { RpcTarget, type RpcStub } from 'capnweb'
import { getSchema } from '@tiptap/core'
import {
	createTypstExtensions,
	exportTypstMarkdown,
	prepareTypstCandidate,
} from '@pluxel/plugin-typst/tiptap'
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
import { studioEditorConfig } from '../shared/editor.js'
import { InputStore } from './inputs.js'
import { DocumentService } from './documents.js'
import { editorResult } from './editor-config.js'
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
			if (!input.editor && input.storageVersion === null)
				input = {
					...input,
					data: description.defaults,
					editor: {
						formatVersion: 1,
						templateId: description.editor.templateId,
						templateRevision: description.editor.templateRevision,
						regions: description.editor.defaults,
					},
				}
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
				const config = studioEditorConfig(snapshot.description.editor!)
				const definitions = snapshot.description.editor!.regions.filter(
					(region) => !input.regionId || region.id === input.regionId,
				)
				if (definitions.length === 0) throw rpcError('FORBIDDEN_REGION', 'Unknown body region')
				if (input.range && !input.regionId)
					throw rpcError('INVALID_INPUT', 'A range requires regionId')
				const regions: BodySnapshot['regions'] = []
				for (const region of definitions) {
					const document = snapshot.input.editor!.regions[region.id]!
					let selected = document
					if (input.range) {
						const native = getSchema(createTypstExtensions(config)).nodeFromJSON(document)
						selected = {
							type: 'doc',
							content: native.slice(input.range.from, input.range.to).content.toJSON(),
						}
					}
					const exported = editorResult(
						exportTypstMarkdown({
							format: 'agent',
							document: selected,
							regionId: region.id,
							config,
							data: snapshot.data,
						}),
					)
					if (input.range)
						editorResult(
							prepareTypstCandidate({
								candidate: {
									regionId: region.id,
									baseRevision: snapshot.baseRevision,
									markdown: exported.markdown,
									format: 'agent',
									range: input.range,
								},
								currentRevision: snapshot.baseRevision,
								document,
								config,
								data: snapshot.data,
								canEdit: () => true,
							}),
						)
					regions.push({
						regionId: region.id,
						label: region.label ?? region.id,
						markdown: exported.markdown,
						...(input.range ? { range: input.range } : {}),
					})
				}
				return {
					projectId: input.projectId,
					entry: input.entry,
					baseRevision: snapshot.baseRevision,
					sourceRevision: snapshot.description.sourceRevision,
					regions,
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
					const document = draft.regions[input.regionId]
					if (!document) throw rpcError('FORBIDDEN_REGION', 'Unknown body region')
					const prepared = editorResult(
						prepareTypstCandidate({
							candidate: {
								regionId: input.regionId,
								baseRevision: input.baseRevision,
								markdown: input.markdown,
								format: 'agent',
								...(input.range ? { range: input.range } : {}),
							},
							currentRevision: snapshot.baseRevision,
							document,
							config: studioEditorConfig(snapshot.description.editor!),
							data: snapshot.data,
							canEdit: () => true,
						}),
					)
					const saved = await this.persist(
						{
							projectId: input.projectId,
							entry: input.entry,
							data: snapshot.input.data,
							editor: {
								...draft,
								regions: { ...draft.regions, [input.regionId]: prepared.mergedDocument },
							},
							expectedVersion: snapshot.input.storageVersion,
						},
						snapshot.description.sourceRevision,
					)
					const receipt: BodyCommit = {
						projectId: input.projectId,
						entry: input.entry,
						input: saved,
						baseRevision: revision(snapshot.description.sourceRevision, saved),
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
							candidate: structuredClone(prepared),
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
