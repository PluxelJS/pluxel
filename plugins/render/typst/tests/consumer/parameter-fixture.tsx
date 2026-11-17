import { createRoot } from 'react-dom/client'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source/browser'
import { createTypstSourceLibrary } from '@pluxel/plugin-typst/source/library'
import { TypstSourceEditor, type TypstSourceEditorProps } from '@pluxel/plugin-typst/tiptap/react'

/** The ordinary public editor without the consumer's custom parameter renderer. */
export async function mountParameterFixture() {
	const files = {
		'main.typ':
			'#import "component.typ": sample\n\n#sample(count: 7, loud: true, title: "原始标题")\n',
		'component.typ':
			'#let sample(count: 2, loud: false, title: "默认标题") = [#title #count #loud]\n',
	}
	const project = await createTypstSourceProject({
		files,
		parserWasm,
		components: [
			{
				module: 'component.typ',
				name: 'sample',
				label: '参数示例',
				parameters: {
					count: { type: 'number', label: '数量' },
					loud: { type: 'boolean', label: '显示标记' },
					title: { type: 'string', label: '标题' },
				},
			},
		],
	})
	return mountEditor(project)
}

/** A filling view: the Typst template is fixed, while its business JSON may be writable. */
export async function mountFieldFixture(writablePaths: readonly string[] = ['data.json']) {
	const project = await createTypstSourceProject({
		parserWasm,
		writablePaths,
		files: {
			...(await createTypstSourceLibrary()),
			'main.typ': `#import "lib/pluxel.typ" as report
#import "component.typ": sample

公司：#report.field(json("data.json"), ("company",))

期间：#report.field(json("data.json"), ("period",))

金额：#report.field(json("data.json"), ("rows", "0", "amount"))

行数：#report.field(json("data.json"), ("rows", "length"))

#sample(data: json("data.json"))
`,
			'component.typ': '#let sample(data:) = [#data.company]\n',
			'data.json': '{"company":"只读公司","period":"2026 Q3","rows":[{"amount":12}]}\n',
		},
		components: [
			{ module: 'component.typ', name: 'sample', label: '数据示例', parameters: {}, data: 'data' },
		],
	})
	return mountEditor(project)
}

function mountEditor(project: Awaited<ReturnType<typeof createTypstSourceProject>>) {
	const element = document.createElement('div')
	element.id = 'typst-parameter-fixture'
	Object.assign(element.style, {
		position: 'fixed',
		inset: '12px',
		zIndex: '1000',
		overflow: 'auto',
		background: 'light-dark(white, #202124)',
		color: 'light-dark(#202124, #eee)',
	})
	document.body.append(element)
	const root = createRoot(element)
	const view = (props: Pick<TypstSourceEditorProps, 'editable' | 'editableFields'> = {}) =>
		root.render(<TypstSourceEditor project={project} path="main.typ" {...props} />)
	view()
	return {
		view,
		files: () => project.snapshot().files,
		undo: () => project.undo(),
		dispose() {
			root.unmount()
			element.remove()
		},
	}
}
