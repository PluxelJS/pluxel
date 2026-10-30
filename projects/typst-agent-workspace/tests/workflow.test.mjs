import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { createTypstSourceEditor } from '@pluxel/plugin-typst/tiptap'
import { bodyPaths, components, dataPath } from '../dist/model.mjs'
import {
	accepted,
	check,
	commit,
	initialize,
	openWorkspace,
	snapshot,
	renderSnapshots,
} from '../dist/workspace.mjs'

const packageRoot = resolve(import.meta.dirname, '..')
const read = (root, path) => readFile(join(root, path), 'utf8')
async function fixture(t) {
	await mkdir(join(packageRoot, '.artifacts'), { recursive: true })
	const root = await mkdtemp(join(packageRoot, '.artifacts/test-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const directory = join(root, 'report')
	await initialize(directory)
	await cp(join(packageRoot, 'tests/fixtures/report'), directory, { recursive: true })
	return directory
}
const changed = (files, path, text) => ({ ...files, [path]: text })
const findText = (editor, text) => {
	let found
	editor.state.doc.descendants((node, position) => {
		if (found === undefined && node.isText && node.text.includes(text))
			found = position + node.text.indexOf(text)
	})
	assert.notEqual(found, undefined, `Expected editable text: ${text}`)
	return found
}

test('the actual accepted report preserves every prose fragment, data value and figure location after migration', async () => {
	const legacy = JSON.parse(await read(packageRoot, 'evidence/markdown-baseline/draft.json'))
	const current = await openWorkspace(join(packageRoot, 'workspace'))
	const prose = (node) =>
		`${node.type === 'text' ? node.text : ''}${(node.content ?? []).map(prose).join('')}`
	for (const [region, document] of Object.entries(legacy.regions))
		assert.equal(prose(current.project.open(`sections/${region}.typ`).document), prose(document))
	assert.deepEqual(JSON.parse(current.files[dataPath]), legacy.data)
	assert.equal(
		current.project.open(bodyPaths[0]).labels.some((value) => value.label === 'fig:revenue'),
		false,
	)
	assert.ok(
		current.project.open(bodyPaths[1]).labels.some((value) => value.label === 'fig:revenue'),
	)
	const tables = current.project
		.open(bodyPaths[0])
		.document.content.filter((node) => node.type === 'table')
	assert.equal(tables.length, 2)
	assert.equal(tables[1].attrs.tableStyle, 'three-line')
	assert.equal(tables[1].content[0].content[0].attrs.colspan, 2)
	assert.equal(tables[1].content[1].content[0].content.length, 2)
})

test('built public entries restore a report using only .typ, JSON and resources', async (t) => {
	for (const entry of [
		'@pluxel/plugin-typst',
		'@pluxel/plugin-typst/source',
		'@pluxel/plugin-typst/tiptap',
	])
		assert.match(import.meta.resolve(entry), /\/dist\/[^/]+\.mjs$/)
	const directory = await fixture(t)
	const current = await openWorkspace(directory)
	assert.equal(
		Object.keys(current.files).some(
			(path) => /\.state|draft\.json|\.md$/.test(path) && path !== 'AGENTS.md',
		),
		false,
	)
	for (const path of bodyPaths) assert.equal(current.project.open(path).editable, true)
	const checked = await check(directory)
	assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics))
})

test('no-op opening and saving preserve exact source bytes, comments and unknown expressions', async (t) => {
	const directory = await fixture(t)
	const current = await openWorkspace(directory)
	for (const path of bodyPaths) {
		const projection = current.project.open(path)
		accepted(current.project.edit({ projection, document: projection.document }))
	}
	const receipt = await commit(directory, {
		baseRevision: current.diskRevision,
		files: current.project.snapshot().files,
	})
	assert.equal(receipt.saved, false)
	const after = await snapshot(directory)
	assert.equal(after.diskRevision, current.diskRevision)
	assert.match(await read(directory, bodyPaths[0]), /#upper\("q3"\)/)
	assert.match(await read(directory, bodyPaths[0]), /#for name in/)
})

test('Agent source edit, real Tiptap Chinese/caption/ref edit, source history, save and reopen', async (t) => {
	const directory = await fixture(t)
	const original = await read(directory, bodyPaths[0])
	await writeFile(
		join(directory, bodyPaths[0]),
		original.replace('详细原因待补充。', '营收同比增长20%，原因仍需核实。'),
	)
	const current = await openWorkspace(directory)
	const issues = []
	const editor = createTypstSourceEditor({
		project: current.project,
		path: bodyPaths[0],
		onIssues: (value) => issues.push(...value),
	})
	const actions = createTypstSourceEditor({
		project: current.project,
		path: bodyPaths[1],
		onIssues: (value) => issues.push(...value),
	})
	t.after(() => {
		editor.destroy()
		actions.destroy()
	})
	const position = findText(editor, '本季度营收增长')
	assert.equal(
		editor.commands.insertContentAt(position, { type: 'text', text: '人工复核：' }),
		true,
	)
	const caption = findText(editor, '季度营收对比')
	assert.equal(editor.commands.insertContentAt(caption, { type: 'text', text: '经复核的' }), true)
	const actionsPosition = findText(actions, '营收趋势见')
	assert.equal(
		actions.commands.insertContentAt(actionsPosition, {
			type: 'reference',
			attrs: { target: 'fig:revenue', showCaption: null },
		}),
		true,
	)
	const edited = current.project.snapshot().files
	assert.match(edited[bodyPaths[0]], /人工复核：/)
	assert.match(edited[bodyPaths[0]], /经复核的季度营收对比/)
	assert.match(edited[bodyPaths[0]], /#text\(fill: red\)\[\*重要事项\*\]/)
	assert.equal((edited[bodyPaths[1]].match(/@fig:revenue/g) ?? []).length, 2)
	assert.deepEqual(issues, [])
	assert.equal(actions.commands.undo(), true)
	assert.equal(
		(current.project.snapshot().files[bodyPaths[1]].match(/@fig:revenue/g) ?? []).length,
		1,
	)
	assert.equal(actions.commands.redo(), true)
	const receipt = await commit(directory, {
		baseRevision: current.diskRevision,
		files: current.project.snapshot().files,
	})
	assert.equal(receipt.saved, true)
	const reopened = await openWorkspace(directory)
	assert.match(reopened.project.open(bodyPaths[0]).source, /人工复核：/)
	assert.equal(
		reopened.project.canUndo,
		false,
		'History is explicit in-memory state, not a hidden restoration requirement',
	)
	assert.equal(reopened.files['template/blocks.typ'], current.files['template/blocks.typ'])
	assert.equal(reopened.files[dataPath], current.files[dataPath])
})

test('cross-file label rename and project undo/redo commit as one filesystem tree', async (t) => {
	const directory = await fixture(t)
	const current = await openWorkspace(directory)
	accepted(
		current.project.renameLabel({
			baseRevision: current.project.revision,
			from: 'fig:revenue',
			to: 'fig:sales',
		}),
	)
	assert.match(current.project.snapshot().files[bodyPaths[0]], /<fig:sales>/)
	assert.match(current.project.snapshot().files[bodyPaths[1]], /@fig:sales/)
	accepted(current.project.undo())
	assert.equal(current.project.snapshot().files[bodyPaths[0]], current.files[bodyPaths[0]])
	assert.equal(current.project.snapshot().files[bodyPaths[1]], current.files[bodyPaths[1]])
	accepted(current.project.redo())
	await commit(directory, {
		baseRevision: current.diskRevision,
		files: current.project.snapshot().files,
	})
	const reopened = await openWorkspace(directory)
	assert.match(reopened.files[bodyPaths[0]], /<fig:sales>/)
	assert.match(reopened.files[bodyPaths[1]], /@fig:sales/)
})

test('static figure move preserves label and resource, subtree copy rebinds only copied references', async (t) => {
	const directory = await fixture(t)
	const current = await openWorkspace(directory)
	const source = current.project.open(bodyPaths[0])
	const brand = source.labels.find((value) => value.label === 'fig:brand')
	assert.ok(brand?.target)
	const copyFrom = brand.target.from
	const copyTo = Buffer.byteLength(source.source)
	accepted(
		current.project.copy({
			baseRevision: current.project.revision,
			path: bodyPaths[0],
			from: copyFrom,
			to: copyTo,
			toPath: bodyPaths[1],
			at: Buffer.byteLength(current.files[bodyPaths[1]]),
		}),
	)
	assert.match(current.project.snapshot().files[bodyPaths[1]], /<fig:brand-copy>/)
	assert.match(current.project.snapshot().files[bodyPaths[1]], /@fig:brand-copy/)
	assert.match(current.project.snapshot().files[bodyPaths[0]], /@fig:brand。/)
	accepted(
		current.project.move({
			baseRevision: current.project.revision,
			path: bodyPaths[0],
			label: 'fig:brand',
			toPath: bodyPaths[1],
			at: Buffer.byteLength(current.project.snapshot().files[bodyPaths[1]]),
		}),
	)
	assert.equal(
		current.project.open(bodyPaths[0]).labels.some((value) => value.label === 'fig:brand'),
		false,
	)
	assert.match(current.project.snapshot().files[bodyPaths[1]], /<fig:brand>/)
	assert.match(current.project.snapshot().files[bodyPaths[1]], /image\("\.\.\/assets\/brand\.svg"/)
	await commit(directory, {
		baseRevision: current.diskRevision,
		files: current.project.snapshot().files,
	})
	assert.match(await read(directory, bodyPaths[1]), /<fig:brand-copy>/)
})

test('invalid later path rejects a whole staged save without modifying the first file', async (t) => {
	const directory = await fixture(t)
	const current = await snapshot(directory)
	await assert.rejects(
		commit(directory, {
			baseRevision: current.diskRevision,
			files: { ...current.files, [bodyPaths[0]]: 'Changed', '../escape.typ': 'bad' },
		}),
	)
	const after = await snapshot(directory)
	assert.equal(after.diskRevision, current.diskRevision)
})

test('external Agent changes reject both stale disk writes and old source projections', async (t) => {
	const directory = await fixture(t)
	const current = await openWorkspace(directory)
	const projection = current.project.open(bodyPaths[0])
	await writeFile(
		join(directory, dataPath),
		JSON.stringify({ ...JSON.parse(current.files[dataPath]), revenue: 180 }),
	)
	const latest = await snapshot(directory)
	await assert.rejects(
		commit(directory, {
			baseRevision: current.diskRevision,
			files: changed(current.files, bodyPaths[1], '= Stale overwrite'),
		}),
		(error) => error.issues?.[0].code === 'CONFLICT',
	)
	const after = await snapshot(directory)
	assert.equal(after.diskRevision, latest.diskRevision)
	accepted(current.project.replace({ baseRevision: current.project.revision, files: latest.files }))
	const stale = current.project.edit({ projection, document: projection.document })
	assert.equal(stale.ok, false)
	assert.equal(stale.issues[0].code, 'CONFLICT')
})

test('invalid Typst drafts remain exact on disk and become editable after explicit repair', async (t) => {
	const directory = await fixture(t)
	const current = await snapshot(directory)
	const invalid = '#text[未闭合😀'
	await commit(directory, {
		baseRevision: current.diskRevision,
		files: changed(current.files, bodyPaths[1], invalid),
	})
	const broken = await openWorkspace(directory)
	assert.equal(broken.files[bodyPaths[1]], invalid)
	assert.equal(broken.project.open(bodyPaths[1]).editable, false)
	const checked = await check(directory)
	assert.equal(checked.valid, false)
	await commit(directory, {
		baseRevision: broken.diskRevision,
		files: changed(broken.files, bodyPaths[1], '#text[已修复😀]'),
	})
	const reopened = await openWorkspace(directory)
	assert.equal(reopened.project.open(bodyPaths[1]).editable, true)
})

test('duplicate and unresolved static labels remain locatable diagnostics', async (t) => {
	const directory = await fixture(t)
	const current = await snapshot(directory)
	const files = changed(
		current.files,
		bodyPaths[1],
		`${current.files[bodyPaths[1]]}\n#figure(rect(), caption: [重复]) <fig:revenue>\n@fig:missing\n`,
	)
	const project = createTypstSourceProject({ files, components })
	const diagnostics = project.diagnostics()
	assert.ok(
		diagnostics.some(
			(issue) => issue.code === 'DUPLICATE_LABEL' && issue.path && Number.isInteger(issue.from),
		),
	)
	assert.ok(
		diagnostics.some(
			(issue) => issue.code === 'UNRESOLVED_REFERENCE' && issue.severity === 'warning',
		),
	)
	const before = project.snapshot()
	const rename = project.renameLabel({
		baseRevision: project.revision,
		from: 'fig:revenue',
		to: 'fig:renamed',
	})
	assert.equal(rename.ok, false)
	assert.deepEqual(project.snapshot(), before)
})

const fonts = JSON.parse(process.env.TYPST_FONT_FILES ?? '[]')
test(
	'same native session recompiles JSON-driven chart, retains failed revision identity, then recovers',
	{ skip: fonts.length === 0 },
	async (t) => {
		const directory = await fixture(t)
		const initial = await snapshot(directory)
		const updated = changed(
			initial.files,
			dataPath,
			JSON.stringify({ ...JSON.parse(initial.files[dataPath]), revenue: 180 }),
		)
		const broken = changed(updated, bodyPaths[1], '#text[broken')
		const recovered = changed(updated, bodyPaths[1], `${updated[bodyPaths[1]]}\n人工复核已通过。\n`)
		const rendered = await renderSnapshots([initial.files, updated, broken, recovered], fonts)
		t.after(() => rm(rendered.job, { recursive: true, force: true }))
		assert.deepEqual(
			rendered.results.map((item) => item.ok),
			[true, true, false, true],
			JSON.stringify(rendered.results),
		)
		assert.equal(new Set(rendered.results.map((item) => item.sessionId)).size, 1)
		assert.equal(rendered.results[2].lastSuccessfulRevision, rendered.results[1].revision)
		assert.notEqual(rendered.results[2].sourceRevision, rendered.results[1].sourceRevision)
		const before = await readFile(join(rendered.job, 'render-1/page-1.png'))
		const after = await readFile(join(rendered.job, 'render-2/page-1.png'))
		assert.notDeepEqual(before, after, 'Only JSON changed; real chart and metrics must recompute')
		assert.equal(updated[bodyPaths[0]], initial.files[bodyPaths[0]])
		assert.equal(updated[bodyPaths[1]], initial.files[bodyPaths[1]])
		const pdf = await readFile(join(rendered.job, 'render-4/report.pdf'))
		assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
		assert.ok(rendered.results[3].pdfBytes > 1000)
	},
)
