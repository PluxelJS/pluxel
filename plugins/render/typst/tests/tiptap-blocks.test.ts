import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { history, undo, redo } from '@tiptap/pm/history'
import { describe, expect, it } from 'vitest'
import {
	applyTypstCandidate,
	createEditorExtensions,
	createTypstExtensions,
	exportTypstMarkdown,
	findTypstGeneratedPosition,
	findTypstRegionPosition,
	generateTypstRegions,
	parseTypstMarkdown,
	prepareTypstCandidate,
	TypstTemplateBlock,
	TypstSource,
	validateTypstRegion,
	validateTypstRegions,
	type TypstEditorConfig,
	type TypstGeneratedRegions,
	type TypstJsonObject,
	type TypstTemplateDefinition,
} from '../src/tiptap/index.js'
import runTypst, { renderTypstPage } from '../src/worker.ts'

const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const document = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const definition: TypstTemplateDefinition = {
	id: 'channel',
	label: 'Channel',
	source: '#heading(level: 2)[#props.title: #data.name / #data.actual]',
	defaults: { title: 'Channel' },
	validateProps: (props) => typeof props.title === 'string' && props.title.length > 0,
}
const plain: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
const config: TypstEditorConfig = {
	...plain,
	extensions: [
		TypstTemplateBlock.configure({
			templates: [
				definition,
				{ id: 'metric', label: 'Metric', source: '#heading(level: 2)[#props.title: #data]' },
				{ id: 'root', label: 'Full input', source: '#heading(level: 2)[#data.period]' },
			],
		}),
		TypstSource,
	],
}
const data = {
	period: 'October',
	channels: [
		{ name: 'Alpha', actual: 10 },
		{ name: 'Beta', actual: 20 },
	],
}
const block = (id: string, title = 'Channel', dataPath = ['channels', '0']): JSONContent => ({
	type: 'templateBlock',
	attrs: { id, template: 'channel', props: { title }, dataPath },
})
const source = (id: string, text = '#heading(level: 2)[Source #data.period]'): JSONContent => ({
	type: 'typstSource',
	attrs: { id, source: text },
})
const validate = (content: JSONContent, rules = config) =>
	validateTypstRegion({ document: content, regionId: 'body', config: rules, data })

describe('native Typst creation commands', () => {
	it('rejects explicit null options without changing content, defaults or history', () => {
		const defaults = { title: 'Default title', extra: [1, 2] }
		const editor = new Editor({
			element: null,
			extensions: createTypstExtensions({
				...plain,
				extensions: [TypstTemplateBlock.configure({ templates: [{ ...definition, defaults }] })],
			}),
			content: document(paragraph('Before')),
		})
		try {
			editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }))
			const initial = editor.getJSON()
			editor.view.dispatch(editor.state.tr.insertText('Keep this edit'))
			const before = editor.getJSON()
			for (const invalid of [{ props: null }, { dataPath: null }]) {
				// JavaScript/JSON callers do not have TypeScript's non-null guarantee.
				const options = { template: 'channel', ...invalid } as unknown as Parameters<
					typeof editor.commands.insertTypstTemplateBlock
				>[0]
				const state = editor.state
				expect(editor.can().insertTypstTemplateBlock(options)).toBe(false)
				expect(editor.state).toBe(state)
				expect(editor.commands.insertTypstTemplateBlock(options)).toBe(false)
				expect(editor.getJSON()).toEqual(before)
				expect(defaults).toEqual({ title: 'Default title', extra: [1, 2] })
			}
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(initial)
			expect(redo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			for (const props of [undefined, { title: 'Explicit title' }]) {
				expect(editor.commands.insertTypstTemplateBlock({ template: 'channel', props })).toBe(true)
				const nodes: JSONContent[] = []
				editor.state.doc.descendants((node) => {
					if (node.type.name === 'templateBlock') nodes.push(node.toJSON())
				})
				expect(nodes.at(-1)!.attrs!.props).toEqual(props ?? defaults)
				expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
				expect(editor.getJSON()).toEqual(before)
			}
		} finally {
			editor.destroy()
		}
	})

	it('shares defaults/identity rules for programmatic insertion and copy with one undo/redo', () => {
		const defaults = { title: 'Nested defaults', values: [1, { value: 2 }] }
		const editor = new Editor({
			element: null,
			extensions: createTypstExtensions({
				...plain,
				extensions: [
					TypstTemplateBlock.configure({ templates: [{ ...definition, defaults }] }),
					TypstSource,
				],
			}),
			content: document(paragraph('Before')),
		})
		try {
			editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }))
			const before = editor.getJSON()
			const state = editor.state
			expect(editor.can().insertTypstTemplateBlock({ template: 'channel' })).toBe(true)
			expect(editor.state).toBe(state)
			expect(defaults.values[1]).toEqual({ value: 2 })
			expect(editor.commands.insertTypstTemplateBlock({ template: 'channel' })).toBe(true)
			const positions: number[] = []
			editor.state.doc.descendants((node, at) => {
				if (node.type.name === 'templateBlock') positions.push(at)
			})
			const at = positions[0]!
			const first = editor.state.doc.nodeAt(at)!
			expect(first.attrs.props).toEqual(defaults)
			expect(first.attrs.props).not.toBe(defaults)
			const inserted = editor.getJSON()
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(redo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(inserted)
			expect(editor.can().duplicateTypstTemplateBlock(at)).toBe(true)
			expect(editor.getJSON()).toEqual(inserted)
			expect(editor.commands.duplicateTypstTemplateBlock(at)).toBe(true)
			const copy = editor.state.doc.nodeAt(at + first.nodeSize)!
			expect(copy.attrs.id).not.toBe(first.attrs.id)
			expect(copy.attrs.props).not.toBe(first.attrs.props)
			copy.attrs.props.values[1].value = 9
			expect(first.attrs.props.values[1].value).toBe(2)
			expect(defaults.values[1]).toEqual({ value: 2 })
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(inserted)
			expect(editor.commands.insertTypstSource('#text[Explicit source]')).toBe(true)
			let sourceAt = -1
			editor.state.doc.descendants((node, pos) => {
				if (node.type.name === 'typstSource') sourceAt = pos
			})
			expect(editor.commands.duplicateTypstSource(sourceAt)).toBe(true)
			const ids: string[] = []
			editor.state.doc.descendants((node) => {
				if (['templateBlock', 'typstSource'].includes(node.type.name)) ids.push(node.attrs.id)
			})
			expect(new Set(ids).size).toBe(ids.length)
			editor.setEditable(false)
			const readOnly = editor.getJSON()
			expect(editor.can().insertTypstSource('')).toBe(false)
			expect(editor.commands.duplicateTypstSource(sourceAt)).toBe(false)
			expect(editor.getJSON()).toEqual(readOnly)
		} finally {
			editor.destroy()
		}
	})
})
function generate(content: JSONContent, input: TypstJsonObject = data, revision = 1) {
	const result = generateTypstRegions({
		regions: { body: content },
		config,
		data: input,
		snapshotRevision: revision,
	})
	if (!result.ok) throw new Error(JSON.stringify(result.issues))
	return result.value
}

describe('optional Typst content blocks', () => {
	it('requires explicit installation and rejects malformed host definitions', () => {
		const base = getSchema(createEditorExtensions())
		expect(base.nodes.templateBlock).toBeUndefined()
		expect(base.nodes.typstSource).toBeUndefined()
		for (const atom of [block('one'), source('two')])
			expect(validate(document(atom), plain)).toMatchObject({
				ok: false,
				issues: [{ code: 'UNKNOWN_NODE' }],
			})
		expect(validate(document(block('one'), source('two')))).toMatchObject({ ok: true })
		for (const templates of [
			[definition, definition],
			[{ ...definition, id: '../outside' }],
			[{ ...definition, label: '' }],
			[{ ...definition, source: ' ' }],
			[{ ...definition, defaults: { title: '' } }],
			[{ ...definition, defaults: { title: new Date() } }],
			[{ ...definition, validateProps: 'not a callback' }],
		]) {
			const rules = {
				...plain,
				extensions: [
					TypstTemplateBlock.configure({ templates: templates as TypstTemplateDefinition[] }),
				],
			}
			expect(validate(document(paragraph('Keep me')), rules)).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_CONFIG' })]),
			})
		}
	})

	it('validates properties, data bindings and unique instance IDs without changing input', () => {
		const original = document(block('one'))
		for (const attrs of [
			{ id: '../escape' },
			{ template: 'unregistered' },
			{ props: [] },
			{ props: { title: 1 } },
			{ props: { title: 'ok', value: Number.NaN } },
			{ dataPath: [0] },
			{ dataPath: ['channels', '9'] },
			{ dataPath: ['channels', '0', 'missing'] },
		]) {
			const invalid = document({
				...block('one'),
				attrs: { ...block('one').attrs, ...attrs },
			})
			expect(validate(invalid)).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_ATTRIBUTE' })]),
			})
		}
		expect(validate(document(block('one'), source('one')))).toMatchObject({
			ok: false,
			issues: [
				expect.objectContaining({ code: 'INVALID_ATTRIBUTE', path: ['content', 1, 'attrs', 'id'] }),
			],
		})
		expect(validate(document({ ...source('one'), attrs: { id: 'one', source: 1 } }))).toMatchObject(
			{ ok: false },
		)
		expect(validate(document(block('whole', 'All data', [])))).toMatchObject({ ok: true })
		// Region-owned filenames permit the same instance ID in two independent regions.
		expect(
			validateTypstRegions({
				regions: { body: original, notes: original },
				config: { ...config, regions: [{ id: 'body' }, { id: 'notes' }] },
				data,
			}),
		).toMatchObject({ ok: true })
		expect(original).toEqual(document(block('one')))
	})

	it('keeps Markdown code inert and reports component/source export as lossy', () => {
		const parsed = parseTypstMarkdown({
			markdown: '```typst\n#heading[Literal example]\n```',
			config,
			regionId: 'body',
			data,
		})
		expect(parsed).toMatchObject({
			ok: true,
			value: { content: [{ type: 'codeBlock', attrs: { language: 'typst' } }] },
		})
		for (const atom of [
			block('one'),
			source('two', '#raw("````")'),
			{ type: 'typstSource', attrs: { id: 'empty' } },
		]) {
			const exported = exportTypstMarkdown({
				config,
				regionId: 'body',
				data,
				document: document(atom),
			})
			expect(exported).toMatchObject({
				ok: true,
				value: {
					lossless: false,
					issues: expect.arrayContaining([expect.objectContaining({ code: 'COMPLEX_CONTENT' })]),
				},
			})
		}
	})

	it('applies a text-only Markdown candidate in one transaction while preserving adjacent atoms and undo', () => {
		const schema = getSchema(createTypstExtensions(config))
		const initial = document(block('one'), paragraph('Original'), source('two'))
		let state = EditorState.create({
			schema,
			doc: schema.nodeFromJSON(initial),
			plugins: [history()],
		})
		let dispatches = 0
		const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
			state = state.apply(transaction)
			dispatches++
		}
		const editor = {
			schema,
			get state() {
				return state
			},
			getJSON: () => state.doc.toJSON(),
			view: { dispatch },
		} as unknown as Editor
		const candidate = prepareTypstCandidate({
			candidate: {
				regionId: 'body',
				baseRevision: 1,
				markdown: '**Updated**',
				range: { from: 1, to: 11 },
			},
			currentRevision: 1,
			document: initial,
			config,
			data,
			canEdit: () => true,
		})
		if (!candidate.ok) throw new Error(JSON.stringify(candidate.issues))
		expect(
			applyTypstCandidate({
				candidate: candidate.value,
				editor,
				regionId: 'body',
				currentRevision: () => 1,
				config,
				data: () => data,
				canEdit: () => true,
			}),
		).toMatchObject({ ok: true })
		expect(dispatches).toBe(1)
		expect(editor.getJSON().content).toEqual([
			initial.content![0],
			{
				type: 'paragraph',
				content: [{ type: 'text', text: 'Updated', marks: [{ type: 'bold' }] }],
			},
			initial.content![2],
		])
		expect(undo(editor.state, dispatch)).toBe(true)
		expect(editor.getJSON()).toEqual(initial)
		for (const range of [undefined, { from: 0, to: 11 }])
			expect(
				prepareTypstCandidate({
					candidate: { regionId: 'body', baseRevision: 1, markdown: 'Discard atoms', range },
					currentRevision: 1,
					document: initial,
					config,
					data,
					canEdit: () => true,
				}),
			).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'COMPLEX_CONTENT' })]),
			})
	})

	it('compiles isolated instances, data-only updates, reordering and raw-source failure recovery with real navigation', async () => {
		const root = await mkdtemp(join(tmpdir(), 'typst-content-blocks-'))
		const bindingPath = fileURLToPath(new URL('../native/compiler.node', import.meta.url))
		let revision = 0
		async function compile(generated: TypstGeneratedRegions) {
			for (const [path, value] of Object.entries({
				'main.typ':
					'#set page(width: 420pt, height: 600pt, margin: 20pt)\n#include "_editor/regions/body.typ"',
				...generated.templateFiles,
				...generated.inputFiles,
			})) {
				const destination = join(root, path.replace(/^\//, ''))
				await mkdir(dirname(destination), { recursive: true })
				await writeFile(destination, value)
			}
			return runTypst({
				root,
				entry: 'main.typ',
				revision: ++revision,
				maxOutputBytes: 8_000_000,
				bindingPath,
			})
		}
		try {
			const first = block('north', 'North', ['channels', '0'])
			const second = block('south', 'South', ['channels', '1'])
			const count: JSONContent = {
				type: 'templateBlock',
				attrs: {
					id: 'count',
					template: 'metric',
					props: { title: 'Count' },
					dataPath: ['channels', 'length'],
				},
			}
			const raw = source(
				'custom',
				'#heading(level: 2)[Source #data.period]\n#par[Exact raw characters]',
			)
			// Raw persisted JSON may omit schema-defaulted props/dataPath/source.
			const fullInput = { type: 'templateBlock', attrs: { id: 'whole', template: 'root' } }
			const emptySource = { type: 'typstSource', attrs: { id: 'empty' } }
			const initial = document(
				first,
				paragraph('Between'),
				second,
				raw,
				count,
				fullInput,
				emptySource,
			)
			const generated = generate(initial)
			const compiled = await compile(generated)
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
			expect(compiled.navigation.outline.map((item) => item.title)).toEqual([
				'North: Alpha / 10',
				'South: Beta / 20',
				'Source October',
				'Count: 2',
				'October',
			])
			expect(Buffer.from(compiled.pdf).subarray(0, 5).toString()).toBe('%PDF-')
			const firstImage = renderTypstPage({
				kind: 'render',
				revision,
				page: 1,
				scale: 1,
				maxOutputBytes: 8_000_000,
			}).data
			const changed = {
				...data,
				period: 'November',
				channels: [{ name: 'Alpha', actual: 30 }, data.channels[1]!],
			}
			const dataOnly = generate(initial, changed)
			expect(dataOnly.templateFiles).toEqual(generated.templateFiles)
			const refreshed = await compile(dataOnly)
			if (!refreshed.ok) throw new Error(JSON.stringify(refreshed.diagnostics))
			expect(refreshed.navigation.outline.map((item) => item.title)).toEqual([
				'North: Alpha / 30',
				'South: Beta / 20',
				'Source November',
				'Count: 2',
				'November',
			])
			const nextImage = renderTypstPage({
				kind: 'render',
				revision,
				page: 1,
				scale: 1,
				maxOutputBytes: 8_000_000,
			}).data
			expect(Buffer.from(firstImage).equals(Buffer.from(nextImage))).toBe(false)
			const reordered = document(
				second,
				paragraph('Between'),
				first,
				raw,
				count,
				fullInput,
				emptySource,
			)
			const moved = generate(reordered, changed, 2)
			const movedCompiled = await compile(moved)
			if (!movedCompiled.ok) throw new Error(JSON.stringify(movedCompiled.diagnostics))
			expect(movedCompiled.navigation.outline.map((item) => item.title)).toEqual([
				'South: Beta / 20',
				'North: Alpha / 30',
				'Source November',
				'Count: 2',
				'November',
			])
			for (const [id, position] of [
				['south', 0],
				['north', 10],
			] as const) {
				const point = movedCompiled.navigation.points.find(
					(entry) => entry.path === `_editor/blocks/body/${id}.typ`,
				)!
				expect(point).toBeDefined()
				expect(
					findTypstRegionPosition({ mapping: moved.mapping, position: point, snapshotRevision: 2 }),
				).toMatchObject({
					regionId: 'body',
					from: position,
					to: position + 1,
				})
				const target = findTypstGeneratedPosition({
					mapping: moved.mapping,
					navigation: movedCompiled.navigation,
					regionId: 'body',
					position,
					snapshotRevision: 2,
				})!
				expect(
					findTypstRegionPosition({
						mapping: moved.mapping,
						position: target,
						snapshotRevision: 2,
					}),
				).toMatchObject({ from: position })
			}
			const rawCharacter = movedCompiled.navigation.points.find(
				(point) =>
					point.path === '_editor/blocks/body/custom.typ' &&
					point.line === 3 &&
					point.column === 10,
			)!
			expect(rawCharacter).toBeDefined()
			expect(
				findTypstRegionPosition({
					mapping: moved.mapping,
					position: rawCharacter,
					snapshotRevision: 2,
				}),
			).toEqual({
				regionId: 'body',
				from: 11,
				to: 12,
				source: { line: 2, column: 10 },
			})
			const broken = generate(document(first, source('custom', '#unknown_function()')))
			const failure = await compile(broken)
			expect(failure).toMatchObject({
				ok: false,
				code: 'COMPILE_FAILED',
				diagnostics: expect.arrayContaining([
					expect.objectContaining({ path: '_editor/blocks/body/custom.typ' }),
				]),
			})
			const recovered = await compile(generated)
			expect(recovered).toMatchObject({ ok: true })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
