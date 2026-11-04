import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { TypstSourceFiles } from '@pluxel/plugin-typst/source'
import { loadNativeCompiler } from '../src/native-binding.ts'
import runTypst from '../src/worker.ts'
import { createTypstDocumentEditor } from '../src/tiptap/document-editor.js'
import { DocumentProject, documentEntry, documentSeed } from './consumer/document-private/project'
import { fontFamilies } from './consumer/source-example'

const normalized = (value: string) => value.normalize('NFKC').replaceAll(/\s/g, '')

async function save(root: string, files: TypstSourceFiles) {
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), contents)
	}
}

it('natively prints the private three-chapter document and paginates complete edited content with working cross-references', async () => {
	const seed = await documentSeed()
	const model = new DocumentProject(seed)
	const titles = model.view().documents.map(({ title }) => title)
	expect(titles).toEqual(['项目背景', '研究方法', '实施计划'])
	const background = model.view().documents.find(({ id }) => id === 'background')!
	const bodyHeading = background.document.content!.find((node) => node.type === 'heading')!
	bodyHeading.attrs = { ...bodyHeading.attrs, level: 1 }
	background.document.content!.push({
		type: 'paragraph',
		content: [
			{ type: 'text', text: '引用策略验收：' },
			{
				type: 'reference',
				attrs: {
					target: model.view().references.find((ref) => ref.title === '研究方法')!.id,
					showCaption: false,
				},
			},
			{ type: 'text', text: '，图示：' },
			{
				type: 'reference',
				attrs: {
					target: model.view().references.find((ref) => ref.kind === 'figure')!.id,
					showCaption: true,
				},
			},
			{ type: 'text', text: '。' },
		],
	})
	model.edit(background.id, background.document)
	const fontPaths = fontFamilies.map((family) => {
		const [matched, path] = execFileSync('fc-match', ['-f', '%{family}\n%{file}', family], {
			encoding: 'utf8',
		}).split('\n')
		if (!matched?.split(',').includes(family) || !path)
			throw new Error(`This regression requires ${family}`)
		return path
	})
	const root = await mkdtemp(join(tmpdir(), 'typst-document-native-'))
	const bindingPath = fileURLToPath(new URL('../native/compiler.node', import.meta.url))
	const paragraphs = Array.from(
		{ length: 90 },
		(_, index) =>
			`续页验收第${index + 1}段：完整记录社区步行观察、不同人群的需求与研究结论，内容增多时应自然换页并保留全部材料。`,
	)
	const tail = '长章末尾验收：全部观察记录已完整保留，后续研究方法与实施计划仍可引用。'
	try {
		const captures: { pages: number; nextChapter: number; printed: string }[] = []
		for (const revision of [1, 2]) {
			if (revision === 2) {
				const chapter = model.view().documents.find(({ id }) => id === 'background')!
				chapter.document.content!.push(
					...[...paragraphs, tail].map((value) => ({
						type: 'paragraph',
						content: [{ type: 'text', text: value }],
					})),
				)
				model.edit(chapter.id, chapter.document)
				model.reorder(['background', 'schedule', 'approach'])
			}
			await save(root, model.files())
			const result = runTypst({
				root,
				entry: documentEntry,
				revision,
				bindingPath,
				maxOutputBytes: 8_000_000,
				fontPaths,
			})
			if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
			expect(result.diagnostics).toEqual([])
			expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
			expect(result.vector.length).toBeGreaterThan(0)
			const view = model.view()
			const topLevel = result.navigation.outline.filter(({ level }) => level === 1)
			expect(topLevel.some(({ title }) => title === '研究目标')).toBe(true)
			const chapters = topLevel.filter(({ title }) =>
				view.documents.some((chapter) => chapter.title === title),
			)
			expect(chapters.map(({ title }) => title)).toEqual(view.documents.map(({ title }) => title))
			const navigation = model.navigation(result.navigation)
			for (const value of [
				'private-proposal',
				'.typ',
				'#import',
				'"path":',
				'"line":',
				'"column":',
			])
				expect(JSON.stringify(navigation)).not.toContain(value)
			const firstText = navigation.points.find(
				(point) => point.documentId === 'background' && point.position === 1,
			)
			expect(firstText).toBeDefined()
			expect(firstText!.endPosition).toBe(2)
			for (const chapter of view.documents) {
				const editor = createTypstDocumentEditor({ content: chapter.document })
				try {
					editor.state.doc.descendants((node, position) => {
						if (node.type.name !== 'reference') return
						const glyphs = navigation.points.filter(
							(point) => point.documentId === chapter.id && point.position === position,
						)
						expect(glyphs.length, `Missing printed reference ${node.attrs.target}`).toBeGreaterThan(
							0,
						)
						// Native links exclude spaces inside a rendered reference's supplement.
						expect(
							glyphs.some((glyph) =>
								navigation.links.some(
									(link) =>
										link.page === glyph.page &&
										link.x <= glyph.x + glyph.width / 2 &&
										link.x + link.width >= glyph.x + glyph.width / 2 &&
										link.y <= glyph.y + glyph.height / 2 &&
										link.y + link.height >= glyph.y + glyph.height / 2,
								),
							),
						).toBe(true)
					})
				} finally {
					editor.destroy()
				}
			}
			const compiler = loadNativeCompiler(bindingPath).create({
				workspace: root,
				fontArgs: [{ fontPaths }],
			})
			const document = compiler.compile({ mainFilePath: join(root, documentEntry) })
			expect(document.result).toBeDefined()
			const svg = compiler.svg(document.result!)
			const printed = normalized(
				[...svg.matchAll(/<h5:div class="tsel"[^>]*>(.*?)<\/h5:div>/g)]
					.map((match) => match[1])
					.join(''),
			)
			const approachNumber = topLevel.findIndex(({ title }) => title === '研究方法') + 1
			const scheduleNumber = topLevel.findIndex(({ title }) => title === '实施计划') + 1
			for (const content of [
				'城市步行环境研究项目书',
				'本项目关注社区步行环境，通过实地观察与访谈形成可执行的改进建议。',
				'采用现场观察、半结构化访谈和路线记录三种方法交叉验证。',
				'观察、访谈与方案评估的研究路径。',
				'方法产出现场观察问题清单访谈需求记录',
				'预计完成率使用p=nN记录。',
				'固定研究提示',
				'按准备、调研和汇总三个阶段推进。',
				`研究路径见Section${approachNumber}，实施安排见Section${scheduleNumber}。`,
				'方法总览见Figure1。',
				`阶段成果参照Section${approachNumber}的方法核验。`,
			])
				expect(printed).toContain(normalized(content))
			expect(svg).toMatch(/<image\b/)
			const destinations = new Set(
				[...svg.matchAll(/handleTypstLocation\(this,\s*(\d+),/g)].map((match) => Number(match[1])),
			)
			for (const chapter of chapters.slice(1)) expect(destinations.has(chapter.page)).toBe(true)
			const nativeDestinations = [
				...svg.matchAll(/handleTypstLocation\(this,\s*(\d+),\s*([\d.-]+),\s*([\d.-]+)\)/g),
			].map((match) => ({ page: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }))
			for (const link of navigation.links) {
				const destination = link.target
				if (destination.kind !== 'position') continue
				expect(
					nativeDestinations.some(
						(target) =>
							target.page === destination.page &&
							Math.abs(target.x - destination.x) < 0.1 &&
							Math.abs(target.y - destination.y) < 0.1,
					),
				).toBe(true)
			}
			for (let index = 0; index < view.documents.length; index++) {
				const id = view.documents[index]!.id
				const anchor = navigation.targets.find(
					(target) => target.location?.documentId === id && target.location.position === 0,
				)
				expect(anchor).toMatchObject({
					page: chapters[index]!.page,
					x: chapters[index]!.x,
					y: chapters[index]!.y,
				})
			}
			captures.push({
				pages: result.navigation.pages.length,
				nextChapter: chapters[1].page,
				printed,
			})
			for (const [path, contents] of Object.entries(seed)) {
				if (
					path === 'private-proposal/chapters/background.typ' ||
					path === 'private-proposal/chapters.json'
				)
					continue
				expect(model.files()[path]).toEqual(contents)
			}
			for (const [path, contents] of Object.entries(seed).filter(
				([file]) => file === documentEntry || file.startsWith('lib/'),
			))
				expect(await readFile(join(root, path))).toEqual(Buffer.from(contents))
		}
		expect(captures[0]!.pages).toBeGreaterThanOrEqual(3)
		expect(captures[1]!.pages).toBeGreaterThan(captures[0]!.pages)
		expect(captures[1]!.nextChapter).toBeGreaterThan(2)
		for (const content of [...paragraphs, tail])
			expect(captures[1]!.printed).toContain(normalized(content))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
