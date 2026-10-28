import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Editor, getSchema } from '@tiptap/core'
import {
	createTypstExtensions,
	exportTypstMarkdown,
	parseTypstMarkdown,
} from '@pluxel/plugin-typst/tiptap'
import { config, initialDraft } from '../dist/model.mjs'
import { initialize, checkout, prepare, apply, snapshot, render } from '../dist/workspace.mjs'

const project = resolve(import.meta.dirname, '..')
const schema = getSchema(createTypstExtensions(config))
const native = (value) => schema.nodeFromJSON(value)
const read = (root, path) => readFile(join(root, path), 'utf8')

test('the consumer resolves Typst through built public entry points', () => {
	for (const entry of ['@pluxel/plugin-typst', '@pluxel/plugin-typst/tiptap']) {
		assert.match(import.meta.resolve(entry), /\/dist\/[^/]+\.mjs$/)
	}
})

async function fixture(t, edited = false) {
	await mkdir(join(project, '.artifacts'), { recursive: true })
	const root = await mkdtemp(join(project, '.artifacts/test-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	await cp(join(project, 'template'), join(root, 'template'), { recursive: true })
	await cp(join(project, 'instructions.md'), join(root, 'instructions.md'))
	await initialize(root)
	const directory = join(root, 'workspace')
	await checkout(root, directory)
	if (edited)
		await cp(join(project, 'workspace/content'), join(directory, 'content'), { recursive: true })
	return { root, directory }
}

test('unmodified file checkout is semantically identical and refuses to overwrite edits', async (t) => {
	const { root, directory } = await fixture(t)
	const before = await read(root, '.state/draft.json')
	const candidate = await prepare(root, directory)
	const receipt = await apply(root, directory)
	assert.deepEqual(candidate.changed, [])
	assert.equal(receipt.saved, false)
	assert.equal(await read(root, '.state/draft.json'), before)
	await assert.rejects(checkout(root, directory), { code: 'EEXIST' })
})

test('the actual agent-edited files move a figure across chapters and preserve complex content', async (t) => {
	const { root, directory } = await fixture(t, true)
	const candidate = await prepare(root, directory)
	assert.deepEqual(candidate.changed, ['analysis', 'actions'])
	const before = initialDraft().regions
	const after = candidate.draft.regions
	assert.equal(
		after.analysis.content.some((node) => node.type === 'figure'),
		false,
	)
	assert.ok(
		native({ type: 'doc', content: [after.actions.content[0]] }).eq(
			native({ type: 'doc', content: [before.analysis.content[2]] }),
		),
	)
	const complex = after.analysis.content.find(
		(node) => node.type === 'table' && node.attrs?.tableStyle === 'three-line',
	)
	assert.ok(
		native({ type: 'doc', content: [complex] }).eq(
			native({ type: 'doc', content: [before.analysis.content.at(-1)] }),
		),
	)
	const table = after.analysis.content.find((node) => node.type === 'table' && node !== complex)
	assert.equal(table.content[0].content.length, 3)
	assert.match(JSON.stringify(table), /62\.5%/)
	assert.equal(
		after.analysis.content.find((node) => node.type === 'templateBlock').attrs.props.title,
		'季度经营指标',
	)
	assert.ok(
		native({ type: 'doc', content: [after.analysis.content[0]] }).eq(
			native({ type: 'doc', content: [before.analysis.content[0]] }),
		),
	)
	assert.equal(after.actions.content.find((node) => node.type === 'orderedList').content.length, 3)
	const receipt = await apply(root, directory)
	assert.equal(receipt.saved, true)
	const savedSnapshot = await snapshot(root)
	const saved = savedSnapshot.draft.regions
	for (const id of Object.keys(after)) assert.ok(native(saved[id]).eq(native(after[id])))
	await assert.rejects(
		apply(root, directory),
		(error) => error.issues?.[0].code === 'STALE_CANDIDATE',
	)
})

test('accepted content remains editable by a real headless Tiptap Editor and round-trips again', async (t) => {
	const { root, directory } = await fixture(t, true)
	await apply(root, directory)
	const current = await snapshot(root)
	const editor = new Editor({
		element: null,
		extensions: createTypstExtensions(config),
		content: current.draft.regions.actions,
	})
	t.after(() => editor.destroy())
	assert.equal(
		editor.commands.insertContentAt(0, {
			type: 'paragraph',
			content: [{ type: 'text', text: '人工复核：建议在周会上确认。' }],
		}),
		true,
	)
	const document = editor.getJSON()
	const exported = exportTypstMarkdown({
		document,
		regionId: 'actions',
		config,
		data: current.data,
		format: 'agent',
	})
	assert.equal(exported.ok, true)
	assert.match(exported.value.markdown, /人工复核/)
	const parsed = parseTypstMarkdown({
		markdown: exported.value.markdown,
		regionId: 'actions',
		config,
		data: current.data,
		format: 'agent',
	})
	assert.equal(parsed.ok, true)
	assert.ok(native(parsed.value).eq(native(document)))
})

test('invalid later chapter cannot partially save an earlier valid edit', async (t) => {
	const { root, directory } = await fixture(t, true)
	const before = await read(root, '.state/draft.json')
	await writeFile(join(directory, 'content/actions.md'), '[ref {broken}]')
	await assert.rejects(apply(root, directory), (error) =>
		error.issues?.some((issue) => issue.file === 'content/actions.md'),
	)
	assert.equal(await read(root, '.state/draft.json'), before)
	assert.equal(await read(directory, 'content/actions.md'), '[ref {broken}]')
})

test('cross-chapter duplicate identity and dangling reference are rejected', async (t) => {
	const { root, directory } = await fixture(t)
	const analysis = await read(directory, 'content/analysis.md')
	const actions = await read(directory, 'content/actions.md')
	const figure = analysis.match(/::::figure[\s\S]*?\n::::/)[0]
	await writeFile(join(directory, 'content/actions.md'), `${figure}\n\n${actions}`)
	await assert.rejects(prepare(root, directory), (error) =>
		error.issues?.some((issue) => issue.code === 'INVALID_REFERENCE'),
	)
	await writeFile(
		join(directory, 'content/actions.md'),
		actions.replace('revenue-figure', 'missing-figure'),
	)
	await assert.rejects(prepare(root, directory), (error) =>
		error.issues?.some((issue) => issue.code === 'INVALID_REFERENCE'),
	)
})

test('invalid component parameters are diagnosed without losing the candidate', async (t) => {
	const { root, directory } = await fixture(t)
	const path = join(directory, 'content/analysis.md')
	const original = await readFile(path, 'utf8')
	const broken = original.replace('"title":"核心指标"', '"title":42')
	await writeFile(path, broken)
	await assert.rejects(prepare(root, directory), (error) =>
		error.issues?.some((issue) => issue.code === 'INVALID_ATTRIBUTE'),
	)
	assert.equal(await readFile(path, 'utf8'), broken)
})

test('a newer data snapshot blocks stale edits and preserves the latest state', async (t) => {
	const { root, directory } = await fixture(t, true)
	const current = await snapshot(root)
	current.draft.data.revenue = 125
	await writeFile(join(root, '.state/draft.json'), JSON.stringify(current.draft))
	await assert.rejects(
		apply(root, directory),
		(error) => error.issues?.[0].code === 'STALE_CANDIDATE',
	)
	const latest = await snapshot(root)
	assert.equal(latest.draft.data.revenue, 125)
})

test('deleted region files and modified context are reported rather than silently ignored', async (t) => {
	const { root, directory } = await fixture(t)
	await writeFile(join(directory, 'context/data.json'), '{}')
	await assert.rejects(
		prepare(root, directory),
		(error) => error.issues?.[0].code === 'INVALID_RESOURCE',
	)
	await rm(join(directory, 'content/actions.md'))
	await assert.rejects(prepare(root, directory), (error) => error.issues?.[0].code === 'REGION_SET')
})

test('ordinary Markdown correctly reports the complex report as lossy', () => {
	const draft = initialDraft()
	const exported = exportTypstMarkdown({
		document: draft.regions.analysis,
		regionId: 'analysis',
		config,
		data: draft.data,
	})
	assert.equal(exported.ok, true)
	assert.equal(exported.value.lossless, false)
})

test(
	'normal Host and injected TypstPlugin compile the edited files to PDF and PNG',
	{
		skip: !process.env.TYPST_FONT_FILES && 'Set TYPST_FONT_FILES to run native rendering',
	},
	async (t) => {
		const { root, directory } = await fixture(t, true)
		const result = await render(root, directory, JSON.parse(process.env.TYPST_FONT_FILES))
		assert.equal(result.pages, 1)
		const pdf = await readFile(join(result.job, 'report.pdf'))
		const image = await readFile(join(result.job, 'page-1.png'))
		assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
		assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
		assert.deepEqual(result.diagnostics, [])
	},
)
