import type { JSONContent } from '@tiptap/core'
import {
	createTypstSourceProject,
	type TypstSourceFiles,
	type TypstSourceProject,
	type TypstSourceResult,
} from '@pluxel/plugin-typst/source'
import {
	createTypstDocumentProject,
	type TypstDocumentProject,
	type TypstDocumentResult,
} from '@pluxel/plugin-typst/document'
import type { TypstNavigation } from '@pluxel/plugin-typst'
import { createTypstSourceLibrary } from '@pluxel/plugin-typst/source/library'

// Test-side evidence: none of this module, its files or comments is a browser asset.
export const documentSourceCanary = 'DOCUMENT_PRIVATE_SOURCE_7c02b738'
export const documentDirectory = 'private-proposal/chapters.json'
export const documentEntry = 'private-proposal/main.typ'
export const documentAsset = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 100">
  <rect x="0" y="0" width="100" height="100" rx="8" fill="#e8edf4"/>
  <rect x="130" y="0" width="100" height="100" rx="8" fill="#dce6f3"/>
  <rect x="260" y="0" width="100" height="100" rx="8" fill="#cbd9ed"/>
  <path d="M100 50h30m100 0h30" stroke="#47678e" stroke-width="3"/>
</svg>`
const assetUrl = '/document-api/asset/architecture'
const assetPath = '../assets/architecture.svg'
const encoder = new TextEncoder()
const chapterPath = (id: string) => `private-proposal/chapters/${id}.typ`
const prelude = '#import "../../lib/pluxel.typ" as report\n\n'
const validId = (id: unknown): id is string =>
	typeof id === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(id)

export class DocumentInputError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'DocumentInputError'
	}
}

function reject(message = '这项内容暂时不能修改，请恢复后重试。'): never {
	throw new DocumentInputError('INVALID_EDIT', message)
}

function accepted<T>(result: TypstSourceResult<T> | TypstDocumentResult<T>): T {
	if (result.ok) return result.value
	const code = result.issues[0]?.code ?? 'INVALID_EDIT'
	throw new DocumentInputError(
		code,
		code === 'CONFLICT' ? '文档已更新，请重新载入后再修改。' : '修改未被接纳，原文档保持不变。',
	)
}

export async function documentSeed(): Promise<Record<string, string>> {
	return {
		...(await createTypstSourceLibrary()),
		[documentDirectory]: JSON.stringify([
			{ id: 'background', title: '项目背景' },
			{ id: 'approach', title: '研究方法' },
			{ id: 'schedule', title: '实施计划' },
		]),
		[documentEntry]: `// ${documentSourceCanary}\n#import "../lib/pluxel.typ" as report
#show: report.document
#set page("a4", margin: 20mm)
#set text(font: "Noto Serif CJK SC", size: 10.5pt)
#set heading(numbering: "1.")
#align(center)[#text(size: 19pt, weight: "bold")[城市步行环境研究项目书]]
#v(8mm)
#for (index, chapter) in json("chapters.json").enumerate() {
  if index > 0 { pagebreak(weak: true) }
  [#heading(level: 1, chapter.title)#label("chapter-" + chapter.id)]
  include ("chapters/" + chapter.id + ".typ")
}
`,
		[chapterPath('background')]: `${prelude}
本项目关注社区步行环境，通过实地观察与访谈形成可执行的改进建议。

研究路径见 @chapter-approach，实施安排见 @chapter-schedule。

== 研究目标

- 记录日常通行中的困难。
- 比较不同人群的需求。
- 提出分阶段的改进方案。
`,
		[chapterPath('approach')]: `${prelude}采用现场观察、半结构化访谈和路线记录三种方法交叉验证。

#figure(image("${assetPath}", width: 100%), caption: [观察、访谈与方案评估的研究路径。]) <object-architecture>

方法总览见 @object-architecture。

#table(columns: (1fr, 1fr), table.header([方法], [产出]), [现场观察], [问题清单], [访谈], [需求记录])

预计完成率使用 #report.latex("p = \\\\frac{n}{N}") 记录。

#upper("固定研究提示")
`,
		[chapterPath('schedule')]: `${prelude}按准备、调研和汇总三个阶段推进。

+ 准备访谈提纲和记录表。
+ 完成实地调研并整理资料。
+ 汇总建议，组织复核。

阶段成果参照 @chapter-approach 的方法核验。
`,
		'private-proposal/assets/architecture.svg': documentAsset,
	}
}

type ChapterEntry = { id: string; title: string }
/** The sole editable state is the existing source project, kept inside the server. */
export class DocumentProject {
	readonly project: TypstSourceProject
	private readonly document: TypstDocumentProject
	private savedKey: string

	constructor(files: TypstSourceFiles) {
		this.project = createTypstSourceProject({
			files,
			writablePaths: [documentDirectory, ...this.entries(files).map(({ id }) => chapterPath(id))],
		})
		this.document = createTypstDocumentProject({
			project: this.project,
			documents: () =>
				this.entries().map(({ id, title }) => ({
					id,
					title,
					path: chapterPath(id),
					label: `chapter-${id}`,
				})),
			resources: [{ path: 'private-proposal/assets/architecture.svg', url: assetUrl }],
		})
		this.savedKey = this.key()
	}

	private entries(files = this.project.snapshot().files): ChapterEntry[] {
		const value: unknown = JSON.parse(String(files[documentDirectory]))
		if (
			!Array.isArray(value) ||
			value.length === 0 ||
			value.some((entry) => !entry || !validId(entry.id) || typeof entry.title !== 'string') ||
			new Set(value.map((entry) => entry.id)).size !== value.length
		)
			throw new Error('Invalid private chapter directory')
		return value
	}

	private key() {
		return JSON.stringify(this.project.snapshot().files)
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

	view() {
		return this.document.view()
	}

	navigation(native: TypstNavigation) {
		return accepted(this.document.navigation({ revision: this.revision, navigation: native }))
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

	edit(id: unknown, input: unknown) {
		accepted(
			this.document.edit({
				baseRevision: this.revision,
				id: this.chapter(id),
				document: input as JSONContent,
			}),
		)
	}

	private directoryPatch(entries: ChapterEntry[]) {
		return {
			path: documentDirectory,
			from: 0,
			to: encoder.encode(String(this.project.snapshot().files[documentDirectory])).length,
			text: JSON.stringify(entries),
		}
	}

	create(id: unknown, title: unknown) {
		if (!validId(id) || this.entries().some((entry) => entry.id === id))
			reject('章节标识无效或已存在。')
		this.checkTitle(title)
		accepted(
			this.project.apply({
				baseRevision: this.revision,
				createFiles: { [chapterPath(id)]: `${prelude}请在这里撰写正文。\n` },
				patches: [this.directoryPatch([...this.entries(), { id, title }])],
			}),
		)
	}

	private checkTitle(title: unknown): asserts title is string {
		if (typeof title !== 'string' || !title.trim() || title.length > 200 || !title.isWellFormed())
			reject('章节名称需要包含 1–200 个字符。')
	}

	rename(id: unknown, title: unknown) {
		const chapterId = this.chapter(id)
		this.checkTitle(title)
		accepted(
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
		accepted(
			this.project.apply({
				baseRevision: this.revision,
				patches: [this.directoryPatch(ids.map((id) => current.find((entry) => entry.id === id)!))],
			}),
		)
	}

	undo() {
		accepted(this.project.undo())
	}
	redo() {
		accepted(this.project.redo())
	}
	files() {
		return this.project.snapshot().files
	}
}
