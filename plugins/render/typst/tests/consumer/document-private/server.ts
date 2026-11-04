import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TypstPlugin, TypstSession } from '@pluxel/plugin-typst'
import type { TypstSourceFiles } from '@pluxel/plugin-typst/source'
import type { DocumentView } from '../document-contract'
import {
	DocumentInputError,
	DocumentProject,
	documentAsset,
	documentEntry,
	documentSeed,
} from './project'

interface Client {
	documentId: string
	model: DocumentProject
	session: TypstSession
	root: string
	tail: Promise<unknown>
	closing: boolean
	compiled?: {
		revision: number
		nativeRevision: number
		pages: readonly { page: number; width: number; height: number }[]
		points: NonNullable<DocumentView['preview']>['points']
		links: NonNullable<DocumentView['preview']>['links']
		targets: NonNullable<DocumentView['preview']>['targets']
	}
	issue?: { code: string; message: string }
}

/** Same native provider as the source demos; no source API or native metadata crosses this boundary. */
export function createDocumentService(options: {
	typst: TypstPlugin
	directory: string
	canOpen(): boolean
	onError(error: unknown): void
}) {
	const clients = new Map<string, Promise<Client>>()
	const savedPath = (id: string) => join(options.directory, id, 'saved.json')
	const asset = () => Buffer.from(documentAsset)

	async function saved(id: string): Promise<TypstSourceFiles> {
		try {
			return JSON.parse(await readFile(savedPath(id), 'utf8')) as TypstSourceFiles
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			return documentSeed()
		}
	}

	async function writeWorkspace(client: Client) {
		await rm(client.root, { recursive: true, force: true })
		await mkdir(client.root, { recursive: true })
		for (const [path, value] of Object.entries(client.model.files())) {
			await mkdir(dirname(join(client.root, path)), { recursive: true })
			await writeFile(join(client.root, path), value)
		}
	}

	async function compile(client: Client) {
		if (client.compiled?.revision === client.model.revision) return
		try {
			await writeWorkspace(client)
			const compiled = await client.session.update({
				files: {},
				template: { root: client.root, entry: documentEntry },
			})
			client.compiled = {
				nativeRevision: compiled.revision,

				...client.model.navigation(compiled.preview.navigation),
			}
			client.issue = undefined
		} catch (error) {
			options.onError(error)
			client.issue = {
				code: 'COMPILE_FAILED',
				message: '内容已接纳，排版暂未完成。请检查本次修改，或撤销后重试。',
			}
		}
	}

	async function open(id: string, documentId: unknown): Promise<Client> {
		if (typeof documentId !== 'string' || !/^[0-9a-f-]{36}$/.test(documentId))
			throw new DocumentInputError('INVALID_DOCUMENT', '文档标识无效。')
		const existing = clients.get(id)
		if (existing) {
			const client = await existing
			if (client.documentId !== documentId)
				throw new DocumentInputError('INVALID_DOCUMENT', '请重新打开文档。')
			return client
		}
		if (!options.canOpen())
			throw new DocumentInputError('BUSY', '打开的文档过多，请先关闭其他演示。')
		const pending = (async () => {
			const root = join(options.directory, id, 'working')
			const model = new DocumentProject(await saved(documentId))
			await mkdir(root, { recursive: true })
			// open() captures a full template, so the initial files must already exist.
			for (const [path, value] of Object.entries(model.files())) {
				await mkdir(dirname(join(root, path)), { recursive: true })
				await writeFile(join(root, path), value)
			}
			const session = await options.typst.open({ root, entry: documentEntry })
			return { documentId, root, model, session, tail: Promise.resolve(), closing: false }
		})()
		clients.set(id, pending)
		try {
			return await pending
		} catch (error) {
			clients.delete(id)
			throw error
		}
	}

	function view(id: string, client: Client): DocumentView {
		const model = client.model
		return {
			dirty: model.dirty,
			...model.view(),
			preview: client.compiled
				? {
						revision: client.compiled.revision,
						points: client.compiled.points,
						links: client.compiled.links,
						targets: client.compiled.targets,
						pages: client.compiled.pages.map((page) => ({
							...page,
							url: `/document-api/page?client=${id}&revision=${client.compiled!.revision}&page=${page.page}`,
						})),
					}
				: null,
			...(client.issue ? { issue: client.issue } : {}),
		}
	}

	async function close(id: string) {
		const pending = clients.get(id)
		if (!pending) return
		const client = await pending
		client.closing = true
		await client.tail.catch(() => {})
		try {
			await client.session.dispose()
		} finally {
			clients.delete(id)
			await rm(client.root, { recursive: true, force: true })
		}
	}

	return {
		get size() {
			return clients.size
		},
		has: (id: string) => clients.has(id),
		asset,
		async execute(
			id: string,
			request: Record<string, unknown>,
		): Promise<DocumentView | Uint8Array | undefined> {
			if (request.action === 'close') {
				await close(id)
				return
			}
			const client =
				request.action === 'open' ? await open(id, request.documentId) : await clients.get(id)
			if (!client || client.closing)
				throw new DocumentInputError('CLOSED', '文档已关闭，请重新打开。')
			const result = client.tail.then(async () => {
				if (request.action === 'pdf') {
					if (
						!client.compiled ||
						request.revision !== client.model.revision ||
						client.compiled.revision !== client.model.revision
					)
						throw new DocumentInputError('STALE_PREVIEW', '请等待当前排版完成后再导出。')
					return client.session.exportPdf(client.compiled.nativeRevision)
				}
				if (request.action !== 'open') client.model.checkRevision(request.baseRevision)
				switch (request.action) {
					case 'open':
						break
					case 'edit':
						client.model.edit(request.chapterId, request.document)
						break
					case 'create':
						client.model.create(request.chapterId, request.title)
						break
					case 'rename':
						client.model.rename(request.chapterId, request.title)
						break
					case 'reorder':
						client.model.reorder(request.chapterIds)
						break
					case 'undo':
						client.model.undo()
						break
					case 'redo':
						client.model.redo()
						break
					case 'save': {
						const destination = savedPath(client.documentId)
						await mkdir(dirname(destination), { recursive: true })
						await writeFile(`${destination}.tmp`, JSON.stringify(client.model.files()))
						await rename(`${destination}.tmp`, destination)
						client.model.markSaved()
						break
					}
					default:
						throw new DocumentInputError('INVALID_ACTION', '不支持这项文档操作。')
				}
				await compile(client)
				return view(id, client)
			})
			client.tail = result.catch(() => {})
			return result
		},
		async image(id: string, revision: number, page: number) {
			const client = await clients.get(id)
			if (!client || client.closing) throw new DocumentInputError('CLOSED', '文档已关闭。')
			const result = client.tail.then(async () => {
				if (
					!client.compiled ||
					client.compiled.revision !== revision ||
					revision !== client.model.revision
				)
					throw new DocumentInputError('STALE_PREVIEW', '预览已更新。')
				const rendered = await client.session.renderPage({
					revision: client.compiled.nativeRevision,
					page,
					scale: 1.5,
				})
				return rendered.data
			})
			client.tail = result.catch(() => {})
			return result
		},
		close: async () => {
			const results = await Promise.allSettled([...clients.keys()].map(close))
			const failures = results.filter((result) => result.status === 'rejected')
			if (failures.length > 0)
				throw new AggregateError(
					failures.map((result) => result.reason),
					'Document sessions failed to close',
				)
		},
	}
}
