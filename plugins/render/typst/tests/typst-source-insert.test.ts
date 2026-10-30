import { expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceLibrary, typstSourceLibrary } from '../src/source/library.js'
import { createTypstSourceEditor, prepareTypstSourceCopy } from '../src/tiptap/source-editor.js'
import { captureBlockTarget, prepareBlockAction } from '../src/tiptap/block-actions.js'
import { sourceInsertEntries } from '../src/tiptap/source-insertions.js'
import { insertEntries, prepareInsertion } from '../src/tiptap/insert-commands.js'
import type { EditorUiContext } from '../src/tiptap/editor-ui.js'

const component = {
	module: 'template/blocks.typ',
	name: 'metrics',
	label: '指标卡',
	parameters: { title: { type: 'string' as const } },
	data: 'data',
}
function fixture(source = '开头 #unknown[保留] 结尾。\n') {
	const files = {
		'sections/body.typ': source,
		'template/blocks.typ': '#let metrics(data: none, title: "默认标题") = [#title]',
		'data/sales.json': '{ "total": 120, "channels": [{"actual": 80}] }\n',
		'lib/pluxel.typ': typstSourceLibrary,
	}
	const project = createTypstSourceProject({
		files,
		components: [component],
		writablePaths: ['sections/body.typ'],
	})
	const editor = createTypstSourceEditor({ project, path: 'sections/body.typ' })
	const catalog = sourceInsertEntries(project, 'sections/body.typ')
	const ui: EditorUiContext = {
		composing: false,
		editable: true,
		fontFamilies: [],
		slashCommands: [],
		sourceEntries: catalog.entries,
		validateDocument: (document) =>
			project.prepareEdit({ projection: project.open('sections/body.typ'), document }).ok,
		prepareDuplicate: (instance, position) =>
			prepareTypstSourceCopy(instance, project, 'sections/body.typ', position),
	}
	return { files, project, editor, catalog, ui }
}
it('exposes detached immutable component declarations from the one project owner', () => {
	const declaration = structuredClone(component)
	const project = createTypstSourceProject({
		files: { 'main.typ': '文' },
		components: [declaration],
	})
	declaration.label = 'changed caller'
	expect(project.components[0]!.label).toBe('指标卡')
	expect(Object.isFrozen(project.components)).toBe(true)
	expect(Object.isFrozen(project.components[0]!.parameters.title)).toBe(true)
	expect(() =>
		Reflect.set(project.components[0]!.parameters.title!, 'type', 'number'),
	).not.toThrow()
	expect(project.components[0]!.parameters.title!.type).toBe('string')
})
it('inserts an explicitly selected JSON-bound component with its import in one native transaction', () => {
	const { files, project, editor, catalog, ui } = fixture()
	try {
		expect(catalog.problems).toEqual([])
		const entry = insertEntries(editor, ui).find(
			(candidate) => candidate.title === '指标卡 · data/sales.json',
		)!
		expect(entry.group).toBe('模板组件')
		editor.commands.setTextSelection(editor.state.doc.content.size - 1)
		const transaction = prepareInsertion(editor, ui, entry)
		expect(transaction).toBeDefined()
		expect(project.revision).toBe(0)
		editor.view.dispatch(transaction!)
		expect(project.revision).toBe(1)
		const source = project.snapshot().files['sections/body.typ'] as string
		expect(source).toContain('#import "../template/blocks.typ" as pluxelInserted')
		expect(source).toContain('#pluxelInserted.metrics(data: json("../data/sales.json"))')
		expect(source).toContain('#unknown[保留]')
		expect(project.snapshot().files['data/sales.json']).toBe(files['data/sales.json'])
		expect(
			editor.getJSON().content!.find((node) => node.type === 'typstComponent')?.attrs,
		).toMatchObject({ props: {}, binding: { file: 'data/sales.json' } })
		let position = -1
		editor.state.doc.forEach((node, at) => {
			if (node.type.name === 'typstComponent') position = at
		})
		const target = captureBlockTarget(editor, position)!
		expect(target).toBeDefined()
		const duplicate = prepareBlockAction(editor, ui, target, 'duplicate')
		expect(duplicate).toBeDefined()
		editor.view.dispatch(duplicate!)
		expect(editor.getJSON().content!.filter((node) => node.type === 'typstComponent')).toHaveLength(
			2,
		)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files['sections/body.typ']).toBe(source)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(files)
	} finally {
		editor.destroy()
	}
})
it('inserts a real nested JSON field and chooses a noncolliding import alias without changing old code', () => {
	const original = '#let pluxelInserted = 4\n\n开头 #unknown[保留] 结尾。\n'
	const { files, project, editor, ui } = fixture(original)
	try {
		const entry = insertEntries(editor, ui).find(
			(candidate) => candidate.title === 'data/sales.json · channels.0.actual',
		)!
		editor.commands.setTextSelection(editor.state.doc.content.size - 2)
		const transaction = prepareInsertion(editor, ui, entry)
		expect(transaction).toBeDefined()
		editor.view.dispatch(transaction!)
		const source = project.snapshot().files['sections/body.typ'] as string
		expect(source).toContain('#let pluxelInserted = 4')
		expect(source).toContain('#import "../lib/pluxel.typ" as pluxelInserted2')
		expect(source).toContain(
			'#pluxelInserted2.field(json("../data/sales.json"), ("channels", 0, "actual",))',
		)
		const fields: unknown[] = []
		editor.state.doc.descendants((node) => {
			if (node.type.name === 'typstField') fields.push(node.attrs)
		})
		expect(fields).toEqual([
			expect.objectContaining({ file: 'data/sales.json', path: ['channels', 0, 'actual'] }),
		])
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(files)
	} finally {
		editor.destroy()
	}
})
it('keeps missing library, malformed JSON, stale choices and readonly admission explicit', () => {
	const missing = createTypstSourceProject({
		files: { 'main.typ': '文', 'data.json': '{"total":1}' },
	})
	const missingCatalog = sourceInsertEntries(missing, 'main.typ')
	expect(missingCatalog.entries('')).toEqual([])
	expect(missingCatalog).toMatchObject({
		problems: [expect.stringContaining('引用库')],
	})
	const invalid = createTypstSourceProject({ files: { 'main.typ': '文', 'data.json': '{broken' } })
	const invalidCatalog = sourceInsertEntries(invalid, 'main.typ')
	expect(invalidCatalog.entries('')).toEqual([])
	expect(invalidCatalog).toMatchObject({
		problems: [expect.stringContaining('修复 JSON')],
	})
	const { project, editor, ui } = fixture()
	try {
		const entry = ui.sourceEntries!('')[0]!
		const source = project.snapshot().files['sections/body.typ'] as string
		expect(
			project.apply({
				baseRevision: 0,
				patches: [{ path: 'sections/body.typ', from: 0, to: 0, text: '改动：' }],
			}).ok,
		).toBe(true)
		expect(prepareInsertion(editor, ui, entry)).toBeUndefined()
		expect(project.snapshot().files['sections/body.typ']).toBe('改动：' + source)
		editor.setEditable(false)
		expect(
			prepareInsertion(
				editor,
				ui,
				sourceInsertEntries(project, 'sections/body.typ').entries('')[0]!,
			),
		).toBeUndefined()
	} finally {
		editor.destroy()
	}
})
it('does not silently turn an inserted field into opaque code when json is shadowed', () => {
	const { files, project, editor, ui } = fixture('#let json = value => none\n\n正文\n')
	try {
		editor.commands.setTextSelection(editor.state.doc.content.size - 1)
		const entry = ui.sourceEntries!('').find((candidate) => candidate.group === '数据字段')!
		expect(prepareInsertion(editor, ui, entry)).toBeUndefined()
		expect(project.snapshot().files).toEqual(files)
	} finally {
		editor.destroy()
	}
})

it('omits only the relocated reference library plugin payload from ordinary JSON insertion choices', async () => {
	const files = Object.fromEntries(
		Object.entries(await createTypstSourceLibrary()).map(([path, contents]) => [
			path.replace(/^lib\//, 'shared/'),
			contents,
		]),
	)
	const project = createTypstSourceProject({
		files: {
			...files,
			'main.typ': '正文',
			'business.json': '{"total":120}',
			'assets/other.wasm.json': '{"description":"ordinary user data"}',
		},
	})
	const catalog = sourceInsertEntries(project, 'main.typ')
	expect(catalog.problems).toEqual([])
	expect(catalog.entries('').map((entry) => entry.title)).toEqual([
		'business.json · total',
		'assets/other.wasm.json · description',
	])
})

it('limits matching choices while keeping fields near the end of a large JSON array searchable and insertable', () => {
	const project = createTypstSourceProject({
		files: {
			'main.typ': '正文',
			'lib/pluxel.typ': typstSourceLibrary,
			'data.json': JSON.stringify({
				records: Array.from({ length: 150_000 }, (_, index) => ({ value: index })),
			}),
		},
	})
	const editor = createTypstSourceEditor({ project, path: 'main.typ' })
	try {
		const catalog = sourceInsertEntries(project, 'main.typ')
		expect(catalog.entries('')).toHaveLength(100)
		const ui: EditorUiContext = {
			composing: false,
			editable: true,
			fontFamilies: [],
			slashCommands: [],
			sourceEntries: catalog.entries,
			validateDocument: (document) =>
				project.prepareEdit({ projection: project.open('main.typ'), document }).ok,
		}
		const entries = insertEntries(editor, ui, undefined, 'records.149999.value')
		const entry = entries.find(
			(candidate) => candidate.title === 'data.json · records.149999.value',
		)
		expect(entry).toBeDefined()
		editor.commands.setTextSelection(2)
		const transaction = prepareInsertion(editor, ui, entry!)
		expect(transaction).toBeDefined()
		editor.view.dispatch(transaction!)
		expect(project.snapshot().files['main.typ']).toContain('("records", 149999, "value",)')
	} finally {
		editor.destroy()
	}
})
