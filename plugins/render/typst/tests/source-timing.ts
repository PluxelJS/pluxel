import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse, parseAst } from '@r4ai/typst-ast-node'
import { projectTypstSource } from '../src/source/project.js'
import { prepareTypstSourceEdit } from '../src/source/writeback.js'
import { createTypstSourceProjectState } from '../src/source/project-state.js'
import type { TypstSourceParser } from '../src/source/types.js'
import { sourceExample } from './consumer/source-example.js'

// Bounded local observations, not a timing gate or a claim about arbitrary reports.
const output = fileURLToPath(
	new URL(
		'../../../../projects/typst-agent-workspace/evidence/source/timings.json',
		import.meta.url,
	),
)
const { files, components } = await sourceExample()
let parserMs = 0
let parseCalls = 0
const parser: TypstSourceParser = {
	parse(source, options) {
		const start = performance.now()
		try {
			return parse(source, options)
		} finally {
			parserMs += performance.now() - start
			parseCalls++
		}
	},
	parseAst(source, options) {
		const start = performance.now()
		try {
			return parseAst(source, options)
		} finally {
			parserMs += performance.now() - start
			parseCalls++
		}
	},
}
const path = 'sections/analysis.typ'
const samples = {
	parser: [] as number[],
	projectionRemainder: [] as number[],
	writeback: [] as number[],
	projectPrepare: [] as number[],
	projectApply: [] as number[],
	prepareParseCalls: [] as number[],
}
const project = createTypstSourceProjectState({ files, components }, parser)
project.diagnostics() // Prime the existing per-file cache, including unrelated template/helper files.
for (let index = 0; index < 35; index++) {
	const source = project.snapshot().files[path] as string
	parserMs = 0
	const start = performance.now()
	const projection = projectTypstSource({
		path,
		revision: project.revision,
		source,
		files,
		components,
		parser,
	})
	const total = performance.now() - start
	const parserTime = parserMs
	const document = structuredClone(projection.document)
	const paragraph = document.content!.find(
		(node) => node.type === 'paragraph' && node.content?.[0]?.type === 'text',
	)!
	assert.ok(paragraph)
	paragraph.content![0]!.text += '核'
	const writeStart = performance.now()
	const patch = prepareTypstSourceEdit(projection, document)
	const writeback = performance.now() - writeStart
	assert.ok(patch.ok)
	project.open(path) // Open the current source as the real editor does before prepareEdit.
	parseCalls = 0
	const prepareStart = performance.now()
	const prepared = project.prepareEdit({ projection, document })
	const projectPrepare = performance.now() - prepareStart
	const calls = parseCalls
	assert.ok(prepared.ok)
	const applyStart = performance.now()
	assert.ok(project.apply(prepared.value).ok)
	const projectApply = performance.now() - applyStart
	if (index >= 5) {
		samples.parser.push(parserTime)
		samples.projectionRemainder.push(total - parserTime)
		samples.writeback.push(writeback)
		samples.projectPrepare.push(projectPrepare)
		samples.projectApply.push(projectApply)
		samples.prepareParseCalls.push(calls)
	}
}
const stats = (values: number[]) => {
	const sorted = values.toSorted((a, b) => a - b)
	return {
		median: +sorted[Math.floor(sorted.length / 2)]!.toFixed(3),
		p95: +sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(3),
		max: +sorted.at(-1)!.toFixed(3),
	}
}
const result = {
	measuredAt: new Date().toISOString(),
	node: process.version,
	fixture: 'plugins/render/typst/tests/consumer/public/source-report',
	files: Object.keys(files).length,
	typstFiles: Object.keys(files).filter((file) => file.endsWith('.typ')).length,
	editedSourceBytes: Buffer.byteLength(files[path]),
	warmup: 5,
	samples: 30,
	units: 'milliseconds except prepareParseCalls (CST + AST calls)',
	stages: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, stats(values)])),
	notes: [
		'Projection remainder includes source offset maps and AST normalization.',
		'Writeback is pure local patch preparation. Project preparation includes validation and candidate projection.',
		'Compilation/session.update is separately measured by artifact/native.json. No worker/cache layer was added from these bounded observations.',
	],
}
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
