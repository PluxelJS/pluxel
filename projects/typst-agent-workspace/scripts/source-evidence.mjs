import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createTypstSourceEditor } from '@pluxel/plugin-typst/tiptap'
import {
	accepted,
	commit,
	initialize,
	openWorkspace,
	renderSnapshots,
	snapshot,
} from '../dist/workspace.mjs'
import { bodyPaths, dataPath } from '../dist/model.mjs'

const root = resolve(import.meta.dirname, '..')
const fonts = JSON.parse(process.env.TYPST_FONT_FILES ?? '[]')
assert.ok(fonts.length, 'Set TYPST_FONT_FILES explicitly')
await mkdir(join(root, '.artifacts'), { recursive: true })
const runRoot = await mkdtemp(join(root, '.artifacts/source-evidence-'))
const directory = join(runRoot, 'report')
await initialize(directory)
await cp(join(root, 'tests/fixtures/report'), directory, { recursive: true })
const initial = await snapshot(directory)
const sourcePath = bodyPaths[0]
// Agent edits the ordinary source file and authoritative JSON, without a Markdown export.
await writeFile(
	join(directory, sourcePath),
	initial.files[sourcePath].replace(
		'详细原因待补充。',
		'营收同比增长20%，原因仍需结合合同验收核实。',
	),
)
const agent = await openWorkspace(directory)
const timing = performance.now()
const issues = []
const editor = createTypstSourceEditor({
	project: agent.project,
	path: sourcePath,
	onIssues: (value) => issues.push(...value),
})
const locate = (text) => {
	let found
	editor.state.doc.descendants((node, position) => {
		if (found === undefined && node.isText && node.text.includes(text))
			found = position + node.text.indexOf(text)
	})
	assert.notEqual(found, undefined)
	return found
}
editor.commands.insertContentAt(locate('本季度营收增长'), { type: 'text', text: '人工复核：' })
editor.commands.insertContentAt(locate('季度营收对比'), { type: 'text', text: '已复核的' })
assert.deepEqual(issues, [])
const editingMs = performance.now() - timing
accepted(
	agent.project.renameLabel({
		baseRevision: agent.project.revision,
		from: 'fig:revenue',
		to: 'fig:income',
	}),
)
const expected = agent.project.snapshot().files
accepted(agent.project.undo())
assert.match(agent.project.snapshot().files[sourcePath], /<fig:revenue>/)
accepted(agent.project.redo())
assert.deepEqual(agent.project.snapshot().files, expected)
const saved = await commit(directory, {
	baseRevision: agent.diskRevision,
	files: agent.project.snapshot().files,
})
editor.destroy()
const reopened = await openWorkspace(directory)
assert.match(reopened.files[sourcePath], /人工复核：/)
assert.match(reopened.files[bodyPaths[1]], /@fig:income/)
const jsonOnly = {
	...reopened.files,
	[dataPath]: `${JSON.stringify({ ...JSON.parse(reopened.files[dataPath]), revenue: 180 }, null, 2)}\n`,
}
const broken = { ...jsonOnly, [bodyPaths[1]]: '#text[未闭合中文😀' }
const repaired = { ...jsonOnly, [bodyPaths[1]]: `${jsonOnly[bodyPaths[1]]}\n人工复核已通过。\n` }
const rendered = await renderSnapshots(
	[initial.files, reopened.files, jsonOnly, broken, repaired],
	fonts,
)
assert.deepEqual(
	rendered.results.map((item) => item.ok),
	[true, true, true, false, true],
	JSON.stringify(rendered.results),
)
assert.equal(new Set(rendered.results.map((item) => item.sessionId)).size, 1)
assert.notDeepEqual(
	await readFile(join(rendered.job, 'render-2/page-1.png')),
	await readFile(join(rendered.job, 'render-3/page-1.png')),
)
const evidence = join(root, 'evidence/source')
await mkdir(evidence, { recursive: true })
for (const [index, name] of [
	'initial',
	'human-edited',
	'json-updated',
	'invalid',
	'repaired',
].entries()) {
	for (const path of [sourcePath, bodyPaths[1], dataPath]) {
		const destination = join(evidence, name, path)
		await mkdir(resolve(destination, '..'), { recursive: true })
		await cp(join(rendered.job, `snapshot-${index + 1}`, path), destination)
	}
	if (name !== 'invalid')
		for (const filename of ['report.pdf', 'page-1.png', 'navigation.json'])
			await cp(join(rendered.job, `render-${index + 1}`, filename), join(evidence, name, filename))
}
let diff
try {
	await promisify(execFile)('git', [
		'diff',
		'--no-index',
		'--no-color',
		join(evidence, 'initial/sections'),
		join(evidence, 'human-edited/sections'),
	])
} catch (error) {
	if (error.code !== 1) throw error
	diff = error.stdout
}
await writeFile(join(evidence, 'source.diff'), (diff ?? '').replaceAll(evidence, 'evidence/source'))
const migratedSource = await snapshot(join(root, 'workspace'))
const migrated = await renderSnapshots([migratedSource.files], fonts)
assert.equal(migrated.results[0].ok, true)
await mkdir(join(evidence, 'migrated-report'), { recursive: true })
for (const filename of ['report.pdf', 'page-1.png', 'navigation.json'])
	await cp(join(migrated.job, 'render-1', filename), join(evidence, 'migrated-report', filename))
const result = {
	saved,
	migratedReport: migrated.results[0],
	editingMs: Math.round(editingMs * 100) / 100,
	results: rendered.results,
}
await writeFile(join(evidence, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ evidence, ...result }, null, 2))
