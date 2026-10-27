import { generateTypstRegions, type JSONContent } from '@pluxel/plugin-typst/tiptap'
import { documentData, editorConfig } from './document'
import type { ExampleBlock } from './protocol'

const blockLabels: Readonly<Record<string, string>> = {
	heading: '标题',
	paragraph: '正文',
	bulletList: '列表',
	orderedList: '编号列表',
	table: '表格',
	blockquote: '引用',
	codeBlock: '代码',
	horizontalRule: '分隔线',
	image: '图片',
}

/** Keep the shared serializer intact; only this example adds clickable block links. */
export function generateExample(options: {
	document: JSONContent
	source: string
	revision: number
}): { files: Record<string, string>; blocks: ExampleBlock[] } {
	if (typeof options.source !== 'string') throw new Error('Typst 模板必须是字符串。')
	if (options.source.length > 8_000)
		throw new Error('此示例的模板与生成源码合计最多 8,000 个字符。')
	const generated = generateTypstRegions({
		regions: { body: options.document },
		config: editorConfig,
		data: documentData,
		snapshotRevision: options.revision,
	})
	if (!generated.ok) throw new Error(generated.issues.map((issue) => issue.message).join('\n'))
	const { templateFiles, inputFiles, mapping } = generated.value
	const sourceLength = [...Object.values(templateFiles), ...Object.values(inputFiles)].reduce(
		(total, text) => total + text.length,
		options.source.length,
	)
	if (sourceLength > 8_000) throw new Error('此示例的模板与生成源码合计最多 8,000 个字符。')

	const path = '_editor/regions/body.typ'
	const source = templateFiles[path]!
	const blocks: ExampleBlock[] = []
	let wrapped = ''
	let cursor = 0
	const ranges = mapping
		.filter((entry) => entry.path === path && entry.kind !== 'text')
		.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
	for (const entry of ranges) {
		// Outermost ranges are the generator's top-level nodes. Nested paragraphs,
		// table cells and inline atoms remain inside their original serialized block.
		if (entry.startOffset < cursor) continue
		const index = blocks.length
		const id = `${options.revision}-${index}`
		const kind = options.document.content?.[index]?.type ?? ''
		blocks.push({
			id,
			from: entry.from,
			to: entry.to,
			label: `${blockLabels[kind] ?? '内容块'} ${index + 1}`,
		})
		wrapped += source.slice(cursor, entry.startOffset)
		wrapped += `#link("pluxel:preview/${id}")[${source.slice(entry.startOffset, entry.endOffset)}]\n`
		cursor = entry.endOffset
	}
	wrapped += source.slice(cursor)
	return {
		files: {
			...Object.fromEntries(
				Object.entries(templateFiles).map(([name, text]) => [`/${name}`, text]),
			),
			...inputFiles,
			[`/${path}`]: wrapped,
		},
		blocks,
	}
}
