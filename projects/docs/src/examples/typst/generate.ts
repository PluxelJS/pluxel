import { createTypstSourceProject } from '@pluxel/plugin-typst/source/browser'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import type { ExampleBlock, ExampleDraft } from './protocol'

const project = createTypstSourceProject({ files: { 'main.typ': '' }, parserWasm })
const blockLabels: Readonly<Record<string, string>> = {
	heading: '标题',
	paragraph: '正文',
	bulletList: '列表',
	orderedList: '编号列表',
	table: '表格',
	blockquote: '引用',
	codeBlock: '代码',
	image: '图片',
	figure: '图表',
}

/** Preview-only links use current source ranges; authored source is never regenerated. */
export async function generateExample(
	options: ExampleDraft,
): Promise<{ source: string; files: Record<string, string>; blocks: ExampleBlock[] }> {
	if (typeof options.source !== 'string' || options.source.length > 8_000)
		throw new Error('此示例的 Typst 源码最多 8,000 个字符。')
	const current = await project
	const accepted = current.replace({
		baseRevision: current.revision,
		files: { 'main.typ': options.source },
	})
	if (!accepted.ok) throw new Error(accepted.issues.map((issue) => issue.message).join('\n'))
	const projection = current.open('main.typ')
	if (!projection.editable) return { source: options.source, files: {}, blocks: [] }
	const blocks: ExampleBlock[] = []
	const bytes = new TextEncoder().encode(options.source)
	const decoder = new TextDecoder('utf-8', { fatal: true })
	let source = ''
	let cursor = 0
	for (const range of projection.mapping
		.filter((entry) => entry.nodePath.length === 1 && entry.kind === 'node')
		.sort((a, b) => a.from - b.from)) {
		const index = range.nodePath[0]!
		const kind = projection.document.content?.[index]?.type ?? ''
		if (!blockLabels[kind]) continue
		const from = range.from
		const to = range.to
		const id = `${options.revision}-${blocks.length}`
		blocks.push({
			id,
			from: range.position,
			to: range.endPosition,
			label: `${blockLabels[kind]} ${blocks.length + 1}`,
		})
		source +=
			decoder.decode(bytes.subarray(cursor, from)) +
			`#link("pluxel:preview/${id}")[${decoder.decode(bytes.subarray(from, to))}]`
		cursor = to
	}
	source += decoder.decode(bytes.subarray(cursor))
	return { source, files: {}, blocks }
}
