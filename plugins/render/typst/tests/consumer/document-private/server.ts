import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { TypstPlugin, TypstSession, TypstTemplate } from '@pluxel/plugin-typst'
import type { DocumentSource, DocumentView } from '../document-contract'
import {
	chapterPath,
	DocumentInputError,
	DocumentProject,
	documentAsset,
	documentAssetPath,
	documentDirectory,
	documentEntry,
	documentSeed,
	documentTemplate,
	readChapterDirectory,
} from './project'

interface Client {
	documentId: string
	savedVersion: string | undefined
	model: DocumentProject
	session: TypstSession
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

/** Example host owns authorized edits and saved chapter files. Each lease owns its compiler session. */
export function createDocumentService(options: {
	typst: TypstPlugin
	directory: string
	canOpen(): boolean
	onError(error: unknown): void
}) {
	const clients = new Map<string, Promise<Client>>()
	const savedOperations = new Map<string, Promise<void>>()
	const savedPath = (id: string) => join(options.directory, id, 'saved.json')
	const templateRoot = join(options.directory, 'template')
	let template: Promise<TypstTemplate> | undefined

	async function prepareTemplate(): Promise<TypstTemplate> {
		const asset = join(templateRoot, documentAssetPath.slice(1))
		await mkdir(dirname(asset), { recursive: true })
		await Promise.all([
			writeFile(asset, documentAsset),
			writeFile(join(templateRoot, documentEntry), documentTemplate),
		])
		return { root: templateRoot, entry: documentEntry }
	}

	function withSavedDocument<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const result = (savedOperations.get(id) ?? Promise.resolve()).then(operation)
		const finished = result.then(
			() => undefined,
			() => undefined,
		)
		savedOperations.set(id, finished)
		return result.finally(() => {
			if (savedOperations.get(id) === finished) savedOperations.delete(id)
		})
	}

	// The marker names a complete, immutable directory of ordinary chapter files.
	async function savedVersion(id: string): Promise<string | undefined> {
		let marker: string
		try {
			marker = await readFile(savedPath(id), 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
			throw error
		}
		const version: unknown = JSON.parse(marker)
		if (typeof version !== 'string' || !/^version-[a-z0-9]{6}$/i.test(version))
			throw new DocumentInputError('MIGRATION_REQUIRED', '已有保存文件需要先转换为 Typst 章节。')
		return version
	}

	async function readSaved(id: string) {
		const version = await savedVersion(id)
		if (version === undefined) return { version, files: documentSeed() }
		const root = join(dirname(savedPath(id)), version)
		const directory = await readFile(join(root, documentDirectory), 'utf8')
		const chapters = await Promise.all(
			readChapterDirectory(directory).map(async ({ id: chapterId }) => {
				const path = chapterPath(chapterId)
				return [path, await readFile(join(root, path), 'utf8')] as const
			}),
		)
		return { version, files: Object.fromEntries([[documentDirectory, directory], ...chapters]) }
	}

	async function save(client: Client) {
		return withSavedDocument(client.documentId, async () => {
			const previous = await savedVersion(client.documentId)
			if (previous !== client.savedVersion)
				throw new DocumentInputError('CONFLICT', '另一会话已保存，请重新打开文档后再修改。')
			if (previous && !client.model.dirty) return
			const marker = savedPath(client.documentId)
			const parent = dirname(marker)
			await mkdir(parent, { recursive: true })
			const root = await mkdtemp(join(parent, 'version-'))
			const version = basename(root)
			const pending = join(parent, `${version}.tmp`)
			try {
				await mkdir(join(root, 'chapters'))
				for (const [path, source] of Object.entries(client.model.files()))
					await writeFile(join(root, path), source)
				await writeFile(pending, JSON.stringify(version), { flag: 'wx' })
				await rename(pending, marker)
			} catch (cause) {
				await Promise.allSettled([
					rm(pending, { force: true }),
					rm(root, { recursive: true, force: true }),
				])
				throw cause
			}
			client.savedVersion = version
			client.model.markSaved()
			if (previous)
				await rm(join(parent, previous), { recursive: true, force: true }).catch(options.onError)
		})
	}

	async function compile(client: Client) {
		if (client.compiled?.revision === client.model.revision) return
		try {
			const compiled = await client.session.update({ files: client.model.compileFiles() })
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
			const saved = await withSavedDocument(documentId, () => readSaved(documentId))
			const model = new DocumentProject(saved.files)
			const session = await options.typst.open(await (template ??= prepareTemplate()))
			return {
				documentId,
				savedVersion: saved.version,
				model,
				session,
				tail: Promise.resolve(),
				closing: false,
			}
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
		const { model, compiled } = client
		return {
			dirty: model.dirty,
			...model.view(),
			preview: compiled
				? {
						revision: compiled.revision,
						points: compiled.points,
						links: compiled.links,
						targets: compiled.targets,
						pages: compiled.pages.map(({ page, width, height }) => ({
							page,
							width,
							height,
							url: `/document-api/page?client=${id}&revision=${compiled.revision}&page=${page}`,
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
		}
	}

	return {
		get size() {
			return clients.size
		},
		has: (id: string) => clients.has(id),
		async execute(
			id: string,
			request: Record<string, unknown>,
		): Promise<DocumentView | DocumentSource | Uint8Array | undefined> {
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
					case 'source':
						return {
							revision: client.model.revision,
							source: client.model.source(request.chapterId),
						}
					case 'edit':
						client.model.edit(request.chapterId, request.content)
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
					case 'save':
						await save(client)
						break
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
			if (!client || client.closing)
				throw new DocumentInputError('CLOSED', '文档已关闭，请重新打开。')
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
