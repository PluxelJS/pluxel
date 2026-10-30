import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceLibrary } from '../src/source/library.js'
import { createTypstSourceEditor } from '../src/tiptap/source-editor.js'
import runTypst, { renderTypstPage } from '../src/worker.ts'
import { loadNativeCompiler } from '../src/native-binding.ts'

const bindingPath = fileURLToPath(new URL('../native/compiler.node', import.meta.url))
const maxOutputBytes = 8_000_000
async function save(root: string, files: Readonly<Record<string, string | Uint8Array>>) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), content)
	}
}
function compile(root: string, revision: number, fontPaths?: string[]) {
	const result = runTypst({
		root,
		entry: 'main.typ',
		revision,
		bindingPath,
		maxOutputBytes,
		fontPaths,
	})
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
	expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
	return result
}
const png = (revision: number) =>
	Buffer.from(renderTypstPage({ kind: 'render', revision, page: 1, scale: 1, maxOutputBytes }).data)

it('compiles an authored empty paragraph and keeps subsequent typing before its neighboring table', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-source-empty-par-'))
	const project = createTypstSourceProject({
		files: {
			'main.typ': '#set page(width: 300pt, height: 220pt)\n#include "body.typ"',
			'body.typ': 'Hello\n\n#table(columns: 1, [Cell])',
		},
	})
	const editor = createTypstSourceEditor({ project, path: 'body.typ' })
	try {
		editor.commands.setTextSelection(6)
		expect(editor.commands.splitBlock()).toBe(true)
		expect(project.open('body.typ').source).toContain('#par[]')
		await save(root, project.snapshot().files)
		compile(root, 1)
		const empty = png(1)
		expect(editor.commands.insertContent({ type: 'text', text: 'New paragraph' })).toBe(true)
		expect(editor.state.doc.child(1).textContent).toBe('New paragraph')
		expect(editor.state.doc.child(2).textContent).toBe('Cell')
		await save(root, project.snapshot().files)
		compile(root, 2)
		expect(png(2).equals(empty)).toBe(false)
	} finally {
		editor.destroy()
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('compiles source-native text styles, alignment, literal whitespace and editor changes into actual pixels and navigation', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-source-style-'))
	const project = createTypstSourceProject({
		files: {
			'main.typ':
				'#set page(width: 360pt, height: 240pt, margin: 20pt)\n#set text(font: "Liberation Serif")\n#include "body.typ"',
			'body.typ': '= Report A😀B\n\nColor sample\n',
		},
	})
	const issues: unknown[] = []
	const editor = createTypstSourceEditor({
		project,
		path: 'body.typ',
		onIssues: (value) => issues.push(...value),
	})
	try {
		let start = 0
		editor.state.doc.descendants((node, position) => {
			if (node.isText && node.text === 'Color sample') start = position
		})
		expect(
			editor
				.chain()
				.setTextSelection({ from: start, to: start + 'Color sample'.length })
				.setMark('textStyle', {
					fontFamily: 'Liberation Serif',
					fontSize: '24px',
					color: '#dc2626',
					backgroundColor: '#ffff00',
				})
				.setBold()
				.setItalic()
				.setUnderline()
				.setStrike()
				.setLink({ href: 'https://example.com/report' })
				.run(),
		).toBe(true)
		expect(editor.commands.setTextAlign('right')).toBe(true)
		expect(issues).toEqual([])
		await save(root, project.snapshot().files)
		const result = compile(root, 1)
		expect(Buffer.from(result.pdf).toString('latin1')).toContain('LiberationSerif')
		expect(result.navigation.outline).toContainEqual(
			expect.objectContaining({ title: 'Report A😀B' }),
		)
		expect(result.navigation.points.some((point) => point.path === 'body.typ')).toBe(true)
		const pixels = pngPixels(png(1))
		let red = 0,
			yellow = 0
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i] === 220 && pixels[i + 1] === 38 && pixels[i + 2] === 38) red++
			if (pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 0) yellow++
		}
		expect(red).toBeGreaterThan(20)
		expect(yellow).toBeGreaterThan(100)
		const right = png(1)
		expect(editor.commands.setTextAlign('left')).toBe(true)
		await save(root, project.snapshot().files)
		compile(root, 2)
		expect(png(2).equals(right)).toBe(false)
		expect(editor.commands.setTextAlign('justify')).toBe(true)
		await save(root, project.snapshot().files)
		compile(root, 3)
		expect(editor.commands.unsetTextAlign()).toBe(true)
		expect(editor.commands.unsetAllMarks()).toBe(true)
		await save(root, project.snapshot().files)
		compile(root, 4)
		expect(issues).toEqual([])
	} finally {
		editor.destroy()
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('renders source-native merged table appearances, including open sides against an independent native line oracle', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-source-table-'))
	const layout = '#set page(width: 300pt, height: 240pt, margin: 20pt)\n#include "body.typ"'
	const project = createTypstSourceProject({
		files: {
			'main.typ': layout,
			'body.typ':
				'#table(columns: 3, inset: 7pt, table.header(table.cell(colspan: 3)[Header]), table.cell(rowspan: 2)[A], [B], [C], table.cell(colspan: 2)[D])',
		},
	})
	const issues: unknown[] = []
	const editor = createTypstSourceEditor({
		project,
		path: 'body.typ',
		onIssues: (value) => issues.push(...value),
	})
	try {
		let revision = 1,
			openSides: Buffer | undefined,
			gridOracle: Buffer | undefined
		for (const tableStyle of ['grid-open-sides', 'grid', 'three-line', 'borderless']) {
			editor.commands.setTextSelection(4)
			expect(editor.commands.updateAttributes('table', { tableStyle })).toBe(true)
			await save(root, { ...project.snapshot().files, 'main.typ': layout })
			compile(root, revision)
			const expected = png(revision++)
			await writeFile(
				join(root, 'main.typ'),
				'#set table.cell(stroke: 2pt + red)\n#set table.hline(stroke: 3pt + blue)\n' + layout,
			)
			compile(root, revision)
			expect(png(revision++).equals(expected)).toBe(true)
			if (tableStyle === 'grid-open-sides') openSides = expected
			if (tableStyle === 'grid') {
				const source = project.snapshot().files['body.typ'] as string
				await writeFile(
					join(root, 'body.typ'),
					source.replace(
						/columns:\s*3,/,
						'columns: 3, table.vline(x: 0, stroke: none), table.vline(x: 3, stroke: none),',
					),
				)
				compile(root, revision)
				gridOracle = png(revision++)
			}
		}
		expect(gridOracle!.equals(openSides!)).toBe(true)
		expect(issues).toEqual([])
	} finally {
		editor.destroy()
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('preserves LaTeX, template reference policy, caption self/mutual refs and real native failure recovery', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-source-math-'))
	const fontFamily = 'DejaVu Math TeX Gyre'
	const [family, fontPath] = execFileSync('fc-match', ['-f', '%{family}\n%{file}', fontFamily], {
		encoding: 'utf8',
	}).split('\n')
	if (family !== fontFamily || !fontPath) throw new Error(`This regression requires ${fontFamily}`)
	const project = createTypstSourceProject({
		files: {
			...(await createTypstSourceLibrary()),
			'main.typ':
				'#import "lib/pluxel.typ" as report\n#show: report.document\n#set text(font: "DejaVu Math TeX Gyre", lang: "en")\n#set page(width: 400pt, height: auto)\n#set math.equation(numbering: "(1)")\n#set figure(supplement: [Object])\n#report.reference-caption.update(true)\n#include "sections/body.typ"\n#include "sections/refs.typ"\n#context assert.eq(counter(math.equation).at(query(<eq:x>).first().location()), (1,))',
			'sections/body.typ':
				'#import "../lib/pluxel.typ" as report\n#figure(table(columns: 1, [A]), caption: [*Caption A* #report.reference(<fig:a>, caption: true) #report.reference(<fig:b>, caption: true)]) <fig:a>\n\n#figure(table(columns: 1, [B]), caption: [Caption B #report.reference(<fig:a>, caption: true)]) <fig:b>\n\n#report.latex("x_1^2 + \\\\alpha", block: true) <eq:x>',
			'sections/refs.typ':
				'#import "../lib/pluxel.typ" as report\nAUTO: #report.reference(<fig:a>)\n\nON: #report.reference(<fig:b>, caption: true)\n\nOFF: #report.reference(<fig:a>, caption: false)\n\nEquation @eq:x',
		},
	})
	try {
		await save(root, project.snapshot().files)
		compile(root, 1, [fontPath])
		const firstImage = png(1)
		const compiler = loadNativeCompiler(bindingPath).create({
			workspace: root,
			fontArgs: [{ fontPaths: [fontPath] }],
		})
		const document = compiler.compile({ mainFilePath: join(root, 'main.typ') })
		expect(document.result).toBeDefined()
		const svg = compiler.svg(document.result!)
		const rendered = [...svg.matchAll(/<h5:div class="tsel"[^>]*>(.*?)<\/h5:div>/g)]
			.map((match) => match[1])
			.join('')
			.replaceAll(/\s/g, '')
		expect(rendered).toContain('AUTO:Object1「CaptionA')
		expect(rendered).toContain('ON:Object2「CaptionB')
		expect(rendered).toContain('OFF:Object1')
		expect([...svg.matchAll(/handleTypstLocation\(this, ([^)]+)\)/g)].length).toBeGreaterThan(5)
		const before = project.open('sections/refs.typ')
		expect(
			project.apply({
				baseRevision: project.revision,
				patches: [
					{
						path: before.path,
						from: 0,
						to: Buffer.byteLength(before.source),
						text: '@missing-target',
					},
				],
			}).ok,
		).toBe(true)
		await save(root, project.snapshot().files)
		const failure = runTypst({
			root,
			entry: 'main.typ',
			revision: 2,
			bindingPath,
			maxOutputBytes,
			fontPaths: [fontPath],
		})
		expect(failure).toMatchObject({ ok: false, code: 'COMPILE_FAILED' })
		expect(png(1).equals(firstImage)).toBe(true)
		expect(() => png(2)).toThrow('Requested Typst revision is no longer available')
		expect(project.undo().ok).toBe(true)
		await save(root, project.snapshot().files)
		compile(root, 3, [fontPath])
		expect(png(3).equals(firstImage)).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('reads fields according to each JSON parent and recompiles JSON-only changes without rewriting Typst', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-source-field-'))
	const source =
		'#import "lib/pluxel.typ" as report\n#set page(width: 400pt, height: auto)\n= #report.field(json("data.json"), ("parent", "0")) / #report.field(json("data.json"), ("parent", "length")) / #report.field(json("data.json"), ("codes", "01"))\n'
	const data = JSON.stringify({
		parent: ['Array first', 'Array second'],
		codes: { '01': 'Leading zero' },
	})
	const project = createTypstSourceProject({
		files: { ...(await createTypstSourceLibrary()), 'main.typ': source, 'data.json': data },
	})
	try {
		const projection = project.open('main.typ'),
			document = structuredClone(projection.document)
		document
			.content!.find((node) => node.type === 'heading')!
			.content!.find((node) => node.type === 'typstField')!.marks = [{ type: 'code' }]
		expect(project.edit({ projection, document }).ok).toBe(true)
		const authored = project.open('main.typ').source
		expect(authored).toContain('#raw(report.field(json("data.json"), ("parent", "0")))')
		await save(root, project.snapshot().files)
		expect(compile(root, 1).navigation.outline).toContainEqual(
			expect.objectContaining({ title: 'Array first / 2 / Leading zero' }),
		)
		const firstImage = png(1)
		const next = JSON.stringify({
			parent: { '0': 'Dictionary zero', length: 9 },
			codes: { '01': 'Still a string key' },
		})
		expect(
			project.apply({
				baseRevision: project.revision,
				patches: [{ path: 'data.json', from: 0, to: Buffer.byteLength(data), text: next }],
			}).ok,
		).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(authored)
		await save(root, project.snapshot().files)
		expect(compile(root, 2).navigation.outline).toContainEqual(
			expect.objectContaining({ title: 'Dictionary zero / 9 / Still a string key' }),
		)
		expect(png(2).equals(firstImage)).toBe(false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('compiles edited native image dimensions, ordered numbering and cell alignment', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-source-attributes-'))
	const project = createTypstSourceProject({
		files: {
			'main.typ': '#set page(width: 400pt, height: 300pt)\n#include "body.typ"',
			'body.typ':
				'#image("asset.svg", width: 45pt, fit: "contain")\n\n#enum(start: 1, numbering: "a.", tight: false, [First], [Second])\n\n#table(columns: (100pt,), table.cell(align: left, fill: yellow)[Cell])',
			'asset.svg':
				'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="#dc2626"/></svg>',
		},
	})
	const editor = createTypstSourceEditor({ project, path: 'body.typ' }),
		issues: unknown[] = []
	try {
		await save(root, project.snapshot().files)
		compile(root, 1)
		const before = png(1),
			projection = project.open('body.typ'),
			doc = structuredClone(projection.document)
		const nodes = (node: typeof doc): (typeof doc)[] => [
			node,
			...(node.content?.flatMap(nodes) ?? []),
		]
		Object.assign(nodes(doc).find((node) => node.type === 'image')!.attrs!, {
			width: 120,
			alt: 'Red chart',
		})
		Object.assign(nodes(doc).find((node) => node.type === 'orderedList')!.attrs!, {
			start: 4,
			type: 'I',
		})
		nodes(doc).find((node) => node.type === 'tableCell')!.attrs!.align = 'right'
		const accepted = project.edit({ projection, document: doc })
		if (!accepted.ok) issues.push(...accepted.issues)
		expect(issues).toEqual([])
		await save(root, project.snapshot().files)
		compile(root, 2)
		expect(png(2).equals(before)).toBe(false)
		const source = project.open('body.typ').source
		expect(source).toContain('width: 90pt')
		expect(source).toContain('numbering: "I."')
		expect(source).toContain('align: right')
		expect(source).toContain('fit: "contain"')
		expect(source).toContain('tight: false')
	} finally {
		editor.destroy()
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

/** Decode RGBA8 output to verify rendered colors rather than only the PNG signature. */
function pngPixels(bytes: Uint8Array): Buffer {
	const data = Buffer.from(bytes)
	expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	expect(data[24]).toBe(8)
	expect(data[25]).toBe(6)
	const width = data.readUInt32BE(16)
	const height = data.readUInt32BE(20)
	const chunks: Buffer[] = []
	for (let offset = 8; offset < data.length;) {
		const length = data.readUInt32BE(offset)
		if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT')
			chunks.push(data.subarray(offset + 8, offset + 8 + length))
		offset += length + 12
	}
	const raw = inflateSync(Buffer.concat(chunks))
	const pixels = Buffer.alloc(width * height * 4)
	const stride = width * 4
	for (let row = 0; row < height; row++) {
		const filter = raw[row * (stride + 1)]!
		for (let x = 0; x < stride; x++) {
			const index = row * stride + x
			const a = x >= 4 ? pixels[index - 4]! : 0
			const b = row ? pixels[index - stride]! : 0
			const c = row && x >= 4 ? pixels[index - stride - 4]! : 0
			const p = a + b - c
			const pa = Math.abs(p - a)
			const pb = Math.abs(p - b)
			const pc = Math.abs(p - c)
			const predictor = [
				0,
				a,
				b,
				Math.floor((a + b) / 2),
				pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
			][filter]
			if (predictor === undefined) throw new Error('Unsupported PNG filter')
			pixels[index] = (raw[row * (stride + 1) + x + 1]! + predictor) & 255
		}
	}
	return pixels
}
