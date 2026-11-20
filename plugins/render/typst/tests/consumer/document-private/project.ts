import type { JSONContent } from '@tiptap/core'
import type { TypstFiles, TypstNavigation, TypstPagePosition } from '@pluxel/plugin-typst'
import {
	parseTypstDocument,
	printTypstDocument,
	type TypstDocumentIssue,
	type TypstDocumentNavigation,
	type TypstDocumentReference,
	type TypstDocumentResult,
} from '@pluxel/plugin-typst/document'
import {
	createTypstSourceProject,
	findTypstEditorPosition,
	type TypstSourceProject,
	type TypstSourceResult,
} from '@pluxel/plugin-typst/source'
import { referenceSource } from '@pluxel/plugin-typst/source/library'
import type { DocumentProjectView } from '../document-contract'

// Only the approved vector edition is included in this template and served to the editor.
export const documentAssetPath = '/body-assets/architecture.svg'
export const documentAsset = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 100">
  <g fill="#e8edf4" stroke="#cbd9ed">
    <rect x="1" y="1" width="98" height="98" rx="8"/>
    <rect x="131" y="1" width="98" height="98" rx="8"/>
    <rect x="261" y="1" width="98" height="98" rx="8"/>
  </g>
  <path d="M100 50h30m100 0h30" fill="none" stroke="#47678e" stroke-width="3"/>
</svg>`
export const documentDirectory = 'chapters.json'
export const documentEntry = 'main.typ'
export const documentTemplate = `// DOCUMENT_PRIVATE_SOURCE_7c02b738
${referenceSource}
#show metadata: render-reference
#set page("a4", margin: 20mm)
#set text(font: "Noto Serif CJK SC", size: 10.5pt)
#set heading(numbering: "1.")
#align(center)[#text(size: 19pt, weight: "bold")[城市步行环境研究项目书]]
#v(8mm)
#for (index, chapter) in json("/inputs/chapters.json").enumerate() {
  if index > 0 { pagebreak(weak: true) }
  [#heading(level: 1, chapter.title)#label("chapter-" + chapter.id)]
  include ("/inputs/chapters/" + chapter.id + ".typ")
  if chapter.id == "approach" { [#upper("固定研究提示")] }
}
`

const encoder = new TextEncoder()
export const chapterPath = (id: string) => `chapters/${id}.typ`
const validId = (value: unknown): value is string =>
	typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value)
const validLabel = (value: unknown): value is string =>
	typeof value === 'string' && /^[a-z][a-z0-9-]{0,87}$/.test(value)
const validTitle = (value: unknown): value is string =>
	typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && value.isWellFormed()

export class DocumentInputError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly issues?: readonly TypstDocumentIssue[],
	) {
		super(message)
		this.name = 'DocumentInputError'
	}
}

function reject(message: string): never {
	throw new DocumentInputError('INVALID_EDIT', message)
}

function sourceAccepted<T>(result: TypstSourceResult<T>): T {
	if (result.ok) return result.value
	if (result.issues.some(({ code }) => code === 'CONFLICT'))
		throw new DocumentInputError('CONFLICT', '文档已更新，请重新载入后再修改。')
	reject('修改未被接纳，原文档保留。')
}

function converted<T>(result: TypstDocumentResult<T>): T {
	if (result.ok) return result.value
	const issue = result.issues[0]
	throw new DocumentInputError(
		issue?.code ?? 'INVALID_EDIT',
		issue?.message ?? '无法接纳章节正文。',
		result.issues,
	)
}

function canonical(source: string): string {
	return converted(printTypstDocument(converted(parseTypstDocument(source)).document)).source
}

export function documentSeed(): Readonly<Record<string, string>> {
	return {
		[documentDirectory]: JSON.stringify([
			{ id: 'background', title: '项目背景' },
			{ id: 'approach', title: '研究方法' },
			{ id: 'schedule', title: '实施计划' },
		]),
		[chapterPath('background')]:
			canonical(`本项目关注社区步行环境，通过实地观察与访谈形成可执行的改进建议。

研究路径见 #ref(<chapter-approach>)，实施安排见 #ref(<chapter-schedule>)。

== 研究目标

- 记录日常通行中的困难。
- 比较不同人群的需求。
- 提出分阶段的改进方案。
`),
		[chapterPath('approach')]: canonical(`采用现场观察、半结构化访谈和路线记录三种方法交叉验证。

#figure(image("${documentAssetPath}", width: 100%), caption: [观察、访谈与方案评估的研究路径。]) <object-architecture>

方法总览见 #ref(<object-architecture>)。

#table(columns: (1fr, 1fr), table.header([方法], [产出]), [现场观察], [问题清单], [访谈], [需求记录])

预计完成率使用 $p = n / N$ 记录。
`),
		[chapterPath('schedule')]: canonical(`按准备、调研和汇总三个阶段推进。

+ 准备访谈提纲和记录表。
+ 完成实地调研并整理资料。
+ 汇总建议，组织复核。

阶段成果参照 #ref(<chapter-approach>) 的方法核验。
`),
	}
}

type ChapterEntry = { id: string; title: string }

export function readChapterDirectory(source: string): readonly ChapterEntry[] {
	const value: unknown = JSON.parse(source)
	if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid chapter directory')
	const ids = new Set<string>()
	return value.map((entry: unknown) => {
		if (
			!entry ||
			typeof entry !== 'object' ||
			Object.keys(entry).length !== 2 ||
			!('id' in entry) ||
			!validId(entry.id) ||
			!('title' in entry) ||
			!validTitle(entry.title) ||
			ids.has(entry.id)
		)
			throw new Error('Invalid chapter directory entry')
		ids.add(entry.id)
		return { id: entry.id, title: entry.title }
	})
}

function publishedUrl(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		(value === documentAssetPath || /^(?:https?:\/\/|mailto:|tel:)/i.test(value))
	)
}

function text(node: JSONContent): string {
	return node.text ?? node.content?.map(text).join('') ?? ''
}

function parseChapter(path: string, source: string) {
	return { path, source, ...converted(parseTypstDocument(source)) }
}

/** The demo host derives its published labels and resource admission from each trusted projection. */
function chapter(id: string, projection: ReturnType<typeof parseChapter>) {
	const labels: TypstDocumentReference[] = []
	const includes = new Set<string>()
	const locations = new Map(
		projection.mapping
			.filter(({ kind }) => kind === 'node')
			.map(({ nodePath, position }) => [nodePath.join('.'), position]),
	)
	function visit(node: JSONContent, path: readonly number[]) {
		if (node.type === 'image' && node.attrs?.src !== documentAssetPath)
			reject('请使用项目书已发布的图片素材。')
		if (node.type === 'reference') {
			const target: unknown = node.attrs?.target
			if (!validLabel(target)) reject('引用目标不合法。')
			includes.add(target)
		}
		for (const mark of node.marks ?? []) {
			if (mark.type === 'link' && !publishedUrl(mark.attrs?.href)) reject('链接目标不允许公开。')
		}
		const label: unknown = node.attrs?.label
		if (label != null) {
			if (!validLabel(label) || !label.startsWith('object-'))
				reject('正文标签应以 object- 开头。章节标签由目录提供。')
			const kind =
				node.type === 'heading'
					? 'heading'
					: node.type === 'blockMath'
						? 'equation'
						: node.content?.some(({ type }) => type === 'table')
							? 'table'
							: 'figure'
			const position = locations.get(path.join('.'))
			labels.push({
				id: label,
				kind,
				title: (kind === 'equation' ? String(node.attrs?.expression ?? '') : text(node)) || label,
				...(position === undefined ? {} : { location: { documentId: id, position } }),
			})
		}
		node.content?.forEach((child, index) => visit(child, [...path, index]))
	}
	visit(projection.document, [])
	return { ...projection, labels, includes }
}

interface DocumentProjection {
	revision: number
	entries: readonly ChapterEntry[]
	chapters: ReadonlyMap<string, ReturnType<typeof chapter>>
	references: ReadonlyMap<string, TypstDocumentReference>
}

export class DocumentProject {
	private readonly project: TypstSourceProject
	private readonly chapters = new Map<string, ReturnType<typeof chapter>>()
	private currentProjection?: DocumentProjection
	private savedKey: string

	constructor(files: Readonly<Record<string, string>>) {
		const entries = readChapterDirectory(files[documentDirectory] ?? '')
		if (Object.keys(files).length !== entries.length + 1)
			throw new Error('Unexpected files in chapter snapshot')
		for (const { id } of entries) {
			const path = chapterPath(id)
			const source = files[path]
			if (source === undefined) throw new Error('Missing chapter source')
			const projection = parseChapter(`inputs/${path}`, source)
			if (converted(printTypstDocument(projection.document)).source !== source)
				throw new Error('Saved chapter requires conversion to canonical Typst')
			this.chapters.set(id, chapter(id, projection))
		}
		this.project = createTypstSourceProject({ files })
		this.references(entries, this.chapters)
		this.savedKey = this.key()
	}

	files(): Readonly<Record<string, string>> {
		const files: Record<string, string> = {}
		for (const [path, source] of Object.entries(this.project.snapshot().files)) {
			if (typeof source !== 'string') throw new Error('Chapter snapshots contain only text files')
			files[path] = source
		}
		return files
	}

	compileFiles(): TypstFiles {
		return Object.fromEntries(
			Object.entries(this.files()).map(([path, source]) => [
				`/inputs/${path}`,
				{ kind: 'text', text: source },
			]),
		)
	}

	private key() {
		return JSON.stringify(this.files())
	}

	get revision() {
		return this.project.revision
	}
	get dirty() {
		return this.key() !== this.savedKey
	}
	markSaved() {
		this.savedKey = this.key()
	}

	private entries(files = this.files()) {
		return readChapterDirectory(files[documentDirectory]!)
	}

	private projected(id: string, source: string) {
		const existing = this.chapters.get(id)
		if (existing?.source === source) return existing
		const parsed = chapter(id, parseChapter(`inputs/${chapterPath(id)}`, source))
		this.chapters.set(id, parsed)
		return parsed
	}

	private references(
		entries: readonly ChapterEntry[],
		chapters: ReadonlyMap<string, ReturnType<typeof chapter>>,
	) {
		const references = new Map<string, TypstDocumentReference>()
		for (const { id, title } of entries) {
			const label = `chapter-${id}`
			references.set(label, {
				id: label,
				title,
				kind: 'heading',
				location: { documentId: id, position: 0 },
			})
		}
		for (const value of chapters.values()) {
			for (const reference of value.labels) {
				if (references.has(reference.id)) reject(`标签 ${reference.id} 已被使用。`)
				references.set(reference.id, reference)
			}
		}
		for (const value of chapters.values()) {
			for (const target of value.includes) {
				if (!references.has(target)) reject(`引用目标 ${target} 不存在。`)
			}
		}
		return references
	}

	private projection(): DocumentProjection {
		if (this.currentProjection?.revision === this.revision) return this.currentProjection
		const files = this.files()
		const entries = this.entries(files)
		const chapters = new Map(
			entries.map(({ id }) => [id, this.projected(id, files[chapterPath(id)]!)]),
		)
		// Undo may remove a chapter. Keep projections only for the active working snapshot.
		for (const id of this.chapters.keys()) {
			if (!chapters.has(id)) this.chapters.delete(id)
		}
		this.currentProjection = {
			revision: this.revision,
			entries,
			chapters,
			references: this.references(entries, chapters),
		}
		return this.currentProjection
	}

	view(): DocumentProjectView {
		const { entries, chapters, references } = this.projection()
		return {
			revision: this.revision,
			canUndo: this.project.canUndo,
			canRedo: this.project.canRedo,
			documents: entries.map(({ id, title }) => ({
				id,
				title,
				editable: true,
				document: chapters.get(id)!.document,
			})),
			references: [...references.values()],
		}
	}

	navigation(native: TypstNavigation): TypstDocumentNavigation {
		const { chapters, references } = this.projection()
		const byPath = new Map(Array.from(chapters, ([id, value]) => [value.path, { id, value }]))
		const points: TypstDocumentNavigation['points'][number][] = []
		for (const source of native.points) {
			const owner = byPath.get(source.path.replace(/^\//, ''))
			if (!owner) continue
			const position = findTypstEditorPosition({ projection: owner.value, sourcePosition: source })
			if (position === undefined) continue
			const end = findTypstEditorPosition({
				projection: owner.value,
				sourcePosition: { path: source.path, line: source.endLine, column: source.endColumn },
			})
			points.push({
				documentId: owner.id,
				position,
				endPosition: Math.max(position + 1, end ?? position + 1),
				page: source.page,
				x: source.x,
				y: source.y,
				width: source.width,
				height: source.height,
			})
		}
		const targets = native.targets.flatMap(({ label, page, x, y }) => {
			const reference = references.get(label)
			return reference
				? [
						{
							id: reference.id,
							page,
							x,
							y,
							...(reference.location ? { location: reference.location } : {}),
						},
					]
				: []
		})
		const positionKey = ({ page, x, y }: TypstPagePosition) => `${page}:${x}:${y}`
		const destinations = new Map<string, (typeof targets)[number] | null>()
		for (const target of targets) {
			const key = positionKey(target)
			destinations.set(key, destinations.has(key) ? null : target)
		}
		const links = native.links.flatMap<TypstDocumentNavigation['links'][number]>(
			({ target, ...box }) => {
				if (target.kind === 'url')
					return publishedUrl(target.url) ? [{ ...box, title: target.url, target }] : []
				const destination = destinations.get(positionKey(target))
				return [
					{
						...box,
						title: (destination && references.get(destination.id)?.title) || '文档位置',
						target: {
							...target,
							...(destination?.location ? { location: destination.location } : {}),
						},
					},
				]
			},
		)
		return { revision: this.revision, pages: native.pages, points, targets, links }
	}

	checkRevision(baseRevision: unknown) {
		if (!Number.isSafeInteger(baseRevision) || baseRevision !== this.revision)
			throw new DocumentInputError('CONFLICT', '文档已更新，请重新载入后再修改。')
	}

	private chapter(id: unknown): string {
		if (!validId(id) || !this.entries().some((entry) => entry.id === id))
			throw new DocumentInputError('NOT_FOUND', '章节不存在。')
		return id
	}

	source(id: unknown): string {
		return this.files()[chapterPath(this.chapter(id))]!
	}

	edit(id: unknown, input: unknown) {
		const chapterId = this.chapter(id)
		if (!input || typeof input !== 'object' || !('kind' in input))
			reject('请提交完整的 Typst 正文或富文本正文。')
		let document: unknown
		if (input.kind === 'typst' && 'source' in input && typeof input.source === 'string')
			document = converted(parseTypstDocument(input.source)).document
		else if (input.kind === 'tiptap' && 'document' in input) document = input.document
		else reject('请提交完整的 Typst 正文或富文本正文。')

		const result = converted(printTypstDocument(document))
		const path = chapterPath(chapterId)
		const previous = this.files()[path]!
		if (previous === result.source) return
		const parsed = chapter(chapterId, parseChapter(`inputs/${path}`, result.source))
		const { entries, chapters } = this.projection()
		this.references(entries, new Map(chapters).set(chapterId, parsed))
		sourceAccepted(
			this.project.apply({
				baseRevision: this.revision,
				patches: [{ path, from: 0, to: encoder.encode(previous).length, text: result.source }],
			}),
		)
		this.chapters.set(chapterId, parsed)
	}

	private directoryPatch(entries: readonly ChapterEntry[]) {
		return {
			path: documentDirectory,
			from: 0,
			to: encoder.encode(this.files()[documentDirectory]!).length,
			text: JSON.stringify(entries),
		}
	}

	create(id: unknown, title: unknown) {
		if (!validId(id) || this.entries().some((entry) => entry.id === id))
			reject('章节标识无效或已存在。')
		if (!validTitle(title)) reject('章节名称需要包含 1–200 个字符。')
		sourceAccepted(
			this.project.apply({
				baseRevision: this.revision,
				createFiles: { [chapterPath(id)]: canonical('请在这里撰写正文。') },
				patches: [this.directoryPatch([...this.entries(), { id, title }])],
			}),
		)
	}

	rename(id: unknown, title: unknown) {
		const chapterId = this.chapter(id)
		if (!validTitle(title)) reject('章节名称需要包含 1–200 个字符。')
		sourceAccepted(
			this.project.apply({
				baseRevision: this.revision,
				patches: [
					this.directoryPatch(
						this.entries().map((entry) =>
							entry.id === chapterId ? { id: entry.id, title } : entry,
						),
					),
				],
			}),
		)
	}

	reorder(ids: unknown) {
		const current = this.entries()
		if (
			!Array.isArray(ids) ||
			ids.length !== current.length ||
			new Set(ids).size !== current.length ||
			ids.some((id) => !current.some((entry) => entry.id === id))
		)
			reject('章节顺序无效，请重新载入。')
		sourceAccepted(
			this.project.apply({
				baseRevision: this.revision,
				patches: [this.directoryPatch(ids.map((id) => current.find((entry) => entry.id === id)!))],
			}),
		)
	}

	undo() {
		sourceAccepted(this.project.undo())
	}
	redo() {
		sourceAccepted(this.project.redo())
	}
}
