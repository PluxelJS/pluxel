import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Editor, Extension, getExtensionField, getSchema, type JSONContent } from '@tiptap/core'
import { history, undo } from '@tiptap/pm/history'
import { describe, expect, it } from 'vitest'
import {
	collectTypstReferenceTargets,
	createTypstExtensions,
	generateTypstRegions,
	TypstSource,
	validateTypstRegion,
	validateTypstRegions,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'
import { copyTypstDocumentNode } from '../src/tiptap/document-nodes.js'
import runTypst from '../src/worker.ts'

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const table: JSONContent = {
	type: 'table',
	content: [
		{
			type: 'tableRow',
			content: [
				{ type: 'tableHeader', content: [paragraph(text('Revenue'))] },
				{ type: 'tableHeader', content: [paragraph(text('42'))] },
			],
		},
	],
}
const figure = (id = 'revenue', label: string | null = 'tbl:revenue'): JSONContent => ({
	type: 'figure',
	attrs: { id, label },
	content: [
		structuredClone(table),
		{ type: 'figureCaption', content: [{ ...text('Revenue summary'), marks: [{ type: 'bold' }] }] },
	],
})
const equation = (id = 'growth', label: string | null = 'eq:growth'): JSONContent => ({
	type: 'blockMath',
	attrs: { id, label, latex: 'g = \\frac{v_1-v_0}{v_0}' },
})
const reference = (target: string): JSONContent => ({ type: 'reference', attrs: { target } })
const config: TypstEditorConfig = { regions: [{ id: 'body' }, { id: 'notes' }], fields: [] }
const regions = () => ({
	body: doc(figure(), equation()),
	notes: doc(
		paragraph(text('See '), reference('revenue'), text(' and '), reference('growth')),
		paragraph({ type: 'inlineMath', attrs: { latex: 'E = mc^2' } }),
	),
})

describe('document objects and cross-file references', () => {
	it('enforces figure structure and exposes captions, labels and native positions separately', () => {
		const value = regions()
		expect(validateTypstRegions({ regions: value, config })).toMatchObject({ ok: true })
		const targets = collectTypstReferenceTargets(value)
		expect(targets).toMatchObject([
			{
				id: 'revenue',
				label: 'tbl:revenue',
				kind: 'table',
				title: 'Revenue summary',
				regionId: 'body',
				position: 0,
			},
			{ id: 'growth', label: 'eq:growth', kind: 'equation', regionId: 'body' },
		])
		const schema = getSchema(createTypstExtensions())
		expect(targets[1]!.position).toBe(schema.nodeFromJSON(figure()).nodeSize)
		for (const content of [
			[table],
			[paragraph(text('Wrong body')), { type: 'figureCaption' }],
			[table, { type: 'figureCaption' }, paragraph(text('Extra'))],
		]) {
			expect(
				validateTypstRegion({
					document: doc({ type: 'figure', content }),
					regionId: 'body',
					config,
				}),
			).toMatchObject({ ok: false, issues: [{ code: 'INVALID_STRUCTURE' }] })
		}
		expect(
			validateTypstRegion({
				document: doc({ type: 'figureCaption', content: [text('Orphan')] }),
				regionId: 'body',
				config,
			}).ok,
		).toBe(false)
	})

	it('rejects duplicate labels or identities across files but permits dangling references while editing', () => {
		for (const other of [equation('revenue', 'eq:other'), equation('other', 'tbl:revenue')])
			expect(
				validateTypstRegions({ regions: { body: doc(figure()), notes: doc(other) }, config }),
			).toMatchObject({ ok: false, issues: [{ code: 'INVALID_REFERENCE', regionId: 'notes' }] })
		const unresolved = { body: doc(paragraph(reference('missing'))), notes: doc(paragraph()) }
		expect(validateTypstRegions({ regions: unresolved, config })).toMatchObject({ ok: true })
		expect(
			generateTypstRegions({ regions: unresolved, config, data: {}, snapshotRevision: 1 }),
		).toMatchObject({
			ok: false,
			issues: [
				{
					code: 'INVALID_REFERENCE',
					regionId: 'body',
					path: ['content', 0, 'content', 0, 'attrs', 'target'],
				},
			],
		})
		for (const target of [null, '', 'bad target'])
			expect(
				validateTypstRegion({
					document: doc(paragraph({ type: 'reference', attrs: { target } })),
					regionId: 'body',
					config,
				}).ok,
			).toBe(false)
		expect(
			validateTypstRegion({
				document: doc({ type: 'blockMath', attrs: { latex: 'x', label: 'eq:x' } }),
				regionId: 'body',
				config,
			}).ok,
		).toBe(false)
	})

	it('resolves a renamed label through stable identity, preserves unnumbered math and leaves template numbering authoritative', () => {
		const value = regions()
		value.body.content![1]!.attrs!.label = 'eq:renamed'
		value.body.content!.push({ type: 'blockMath', attrs: { latex: 'x + y' } })
		const result = generateTypstRegions({ regions: value, config, data: {}, snapshotRevision: 1 })
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		expect(result.value.templateFiles['_editor/regions/body.typ']).toContain('#label("eq:renamed")')
		expect(result.value.templateFiles['_editor/regions/notes.typ']).toContain(
			'#editor-ref(label("eq:renamed"), show-caption: auto)',
		)
		expect(result.value.templateFiles['_editor/regions/body.typ']).toContain(
			'#mitex("x + y", numbering: none)',
		)
		expect(result.value.templateFiles['_editor/regions/body.typ']).not.toContain(
			'set math.equation',
		)
		expect(result.value.templateFiles['_editor/mitex/mitex.typ']).toBeDefined()
	})

	it('adopts installed source nodes without making them mandatory figure dependencies', () => {
		const sourceFigure: JSONContent = {
			type: 'figure',
			attrs: { id: 'source', label: 'fig:source' },
			content: [
				{ type: 'typstSource', attrs: { id: 'raw', source: '#rect(width: 20pt, height: 20pt)' } },
				{ type: 'figureCaption', content: [text('Diagram')] },
			],
		}
		expect(validateTypstRegion({ document: doc(sourceFigure), regionId: 'body', config }).ok).toBe(
			false,
		)
		expect(
			validateTypstRegion({
				document: doc(sourceFigure),
				regionId: 'body',
				config: { ...config, extensions: [TypstSource] },
			}),
		).toMatchObject({ ok: true })
	})

	it('rejects installed global attributes without a built-in serializer mapping', () => {
		const Extra = Extension.create({
			name: 'unmappedParagraphSpacing',
			addGlobalAttributes: () => [
				{ types: ['paragraph'], attributes: { indent: { default: null } } },
			],
		})
		expect(
			validateTypstRegions({ regions: regions(), config: { ...config, extensions: [Extra] } }),
		).toMatchObject({ ok: false, issues: [{ code: 'MISSING_SERIALIZER' }] })
	})

	it('native insert and duplicate commands create independent identities and one undo step', () => {
		const editor = new Editor({
			element: null,
			extensions: createTypstExtensions(),
			content: doc(paragraph(text('Before'))),
		})
		try {
			editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }))
			const before = editor.getJSON()
			expect(editor.commands.insertTypstFigure({ body: table, caption: [text('Caption')] })).toBe(
				true,
			)
			let position = -1
			editor.state.doc.descendants((node, pos) => {
				if (node.type.name === 'figure') position = pos
			})
			const original = editor.state.doc.nodeAt(position)!
			expect(original.attrs.label).toMatch(/^tbl:/)
			expect(editor.commands.duplicateTypstFigure(position)).toBe(true)
			const duplicated = editor.state.doc.nodeAt(position + original.nodeSize)!
			expect(duplicated.attrs.id).not.toBe(original.attrs.id)
			expect(duplicated.attrs.label).not.toBe(original.attrs.label)
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(editor.commands.insertBlockMath({ latex: 'x = 1' })).toBe(true)
			const targets = collectTypstReferenceTargets({ body: editor.getJSON() })
			expect(targets[0]).toMatchObject({ kind: 'equation', title: 'x = 1' })
			expect(editor.commands.duplicateTypstBlockMath(targets[0]!.position)).toBe(true)
			expect(
				new Set(collectTypstReferenceTargets({ body: editor.getJSON() }).map((target) => target.id))
					.size,
			).toBe(2)
		} finally {
			editor.destroy()
		}
	})

	it('exits the end of a caption into a following paragraph in one native undo step', () => {
		const editor = new Editor({
			element: null,
			extensions: createTypstExtensions(),
			content: doc(figure()),
		})
		try {
			editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }))
			const before = editor.getJSON()
			const extension = editor.extensionManager.extensions.find(
				(item) => item.name === 'figureCaption',
			)!
			const shortcuts = getExtensionField(extension, 'addKeyboardShortcuts', {
				editor,
				name: extension.name,
				options: extension.options,
				storage: extension.storage,
			})!()
			expect(shortcuts['Shift-Enter']).toBeUndefined()
			editor.commands.setTextSelection(editor.state.doc.content.size - 2)
			expect(shortcuts.Enter!({ editor })).toBe(true)
			expect(editor.state.doc.lastChild!.type.name).toBe('paragraph')
			expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			editor.commands.setContent(doc(figure(), paragraph(text('Following'))))
			const existing = editor.getJSON()
			editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 2)
			expect(shortcuts.Enter!({ editor })).toBe(true)
			expect(editor.getJSON()).toEqual(existing)
			expect(editor.state.selection.$from.parent.textContent).toBe('Following')
			editor.setEditable(false)
			editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 2)
			expect(shortcuts.Enter!({ editor })).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('copies a whole subtree with internal references following new objects', () => {
		const schema = getSchema(createTypstExtensions())
		const original = doc(
			figure(),
			equation(),
			paragraph(reference('growth'), reference('external')),
		)
		const copy = copyTypstDocumentNode(original, schema.nodeFromJSON(original), true)
		expect(copy.content![2]!.content![0]!.attrs!.target).toBe(copy.content![1]!.attrs!.id)
		expect(copy.content![2]!.content![1]!.attrs!.target).toBe('external')
		expect(original.content![1]!.attrs!.id).toBe('growth')
	})

	it('keeps reference identities separate from source instance filenames while copying', () => {
		const sourceConfig = { ...config, extensions: [TypstSource] }
		const schema = getSchema(createTypstExtensions(sourceConfig))
		const original = doc({
			type: 'figure',
			attrs: { id: 'same-id', label: 'fig:diagram' },
			content: [
				{ type: 'typstSource', attrs: { id: 'same-id', source: '#rect()' } },
				{ type: 'figureCaption', content: [text('See '), reference('same-id')] },
			],
		})
		expect(
			validateTypstRegion({ document: original, regionId: 'body', config: sourceConfig }).ok,
		).toBe(true)
		const copy = copyTypstDocumentNode(original, schema.nodeFromJSON(original), true)
		const copiedFigure = copy.content![0]!
		expect(copiedFigure.content![1]!.content![1]!.attrs!.target).toBe(copiedFigure.attrs!.id)
		expect(copiedFigure.content![0]!.attrs!.id).not.toBe(copiedFigure.attrs!.id)
	})
})

it('compiles captions, LaTeX, and references across included files using only bundled MiTeX', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-document-native-'))
	try {
		const documentRegions = regions()
		documentRegions.body.content![0]!.attrs!.label = '表:季度营收'
		documentRegions.body.content![1]!.attrs!.label = '公式:增长率'
		const result = generateTypstRegions({
			regions: documentRegions,
			config,
			data: {},
			snapshotRevision: 1,
		})
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		for (const [path, content] of Object.entries({
			...result.value.templateFiles,
			...result.value.inputFiles,
		})) {
			const output = join(root, path.replace(/^\//, ''))
			await mkdir(dirname(output), { recursive: true })
			await writeFile(output, content)
		}
		await writeFile(
			join(root, 'main.typ'),
			'#set math.equation(numbering: "(1)")\n#set figure(supplement: [Object])\n#include "_editor/regions/body.typ"\n#include "_editor/regions/notes.typ"',
		)
		const compiled = runTypst({
			revision: 1,
			root,
			entry: 'main.typ',
			maxOutputBytes: 8_000_000,
			bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		})
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
		expect(Buffer.from(compiled.pdf).subarray(0, 5).toString()).toBe('%PDF-')
		expect(compiled.vector.byteLength).toBeGreaterThan(100)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('lets the template enable captioned table pagination and repeat headers across pages', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-captioned-table-'))
	try {
		const longFigure = figure('long-table', 'tbl:long')
		longFigure.content![0]!.content!.push(
			...Array.from({ length: 60 }, (_, index) => ({
				type: 'tableRow',
				content: [
					{ type: 'tableCell', content: [paragraph(text(`Row ${index + 1}`))] },
					{ type: 'tableCell', content: [paragraph(text(`${index + 1}`))] },
				],
			})),
		)
		const result = generateTypstRegions({
			regions: { body: doc(longFigure), notes: doc(paragraph(reference('long-table'))) },
			config,
			data: {},
			snapshotRevision: 1,
		})
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		for (const [path, content] of Object.entries({
			...result.value.templateFiles,
			...result.value.inputFiles,
		})) {
			const output = join(root, path.replace(/^\//, ''))
			await mkdir(dirname(output), { recursive: true })
			await writeFile(output, content)
		}
		await writeFile(
			join(root, 'main.typ'),
			[
				'#set page(width: 90mm, height: 90mm, margin: 8mm)',
				'#show figure.where(kind: table): set block(breakable: true)',
				'#show figure.where(kind: table): set figure.caption(position: top)',
				'#include "_editor/regions/body.typ"',
				'#include "_editor/regions/notes.typ"',
			].join('\n'),
		)
		const compiled = runTypst({
			revision: 1,
			root,
			entry: 'main.typ',
			maxOutputBytes: 8_000_000,
			bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		})
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
		expect(compiled.navigation.pages.length).toBeGreaterThan(2)
		// The first header glyph keeps its generated source identity on every table page.
		const headerMapping = result.value.mapping.find(
			(item) => item.regionId === 'body' && item.kind === 'text',
		)!
		const headerPages = new Set(
			compiled.navigation.points
				.filter(
					(point) =>
						point.path === headerMapping.path &&
						point.line === headerMapping.range.start.line &&
						point.column === headerMapping.range.start.column,
				)
				.map((point) => point.page),
		)
		expect(headerPages.size).toBeGreaterThan(2)
		expect(result.value.templateFiles['_editor/regions/body.typ']).not.toContain('breakable:')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
