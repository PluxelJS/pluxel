import type { JSONContent, TypstEditorConfig } from '@pluxel/plugin-typst/tiptap'

export const editorConfig: TypstEditorConfig = {
	regions: [{ id: 'body', label: '正文' }],
	fields: [],
}

export const fontFamilies = ['LXGW WenKai']
export const documentData = {}

const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const cell = (text: string, header = false): JSONContent => ({
	type: header ? 'tableHeader' : 'tableCell',
	attrs: { colspan: 1, rowspan: 1, colwidth: null },
	content: [paragraph(text)],
})

export const initialDocument: JSONContent = {
	type: 'doc',
	content: [
		{
			type: 'heading',
			attrs: { level: 1 },
			content: [{ type: 'text', text: 'Pluxel × Typst' }],
		},
		paragraph('这份文档在你的浏览器中完成排版。'),
		{
			type: 'paragraph',
			content: [
				{ type: 'text', text: '真实插件，实时排版。', marks: [{ type: 'bold' }] },
				{ type: 'text', text: 'Pluxel 管理依赖和生命周期，Typst WASM 负责生成文档。' },
			],
		},
		{
			type: 'heading',
			attrs: { level: 2 },
			content: [{ type: 'text', text: '试着修改' }],
		},
		{
			type: 'bulletList',
			content: [
				'直接编辑正文，预览会自动更新；点击两边可对照跳转。',
				'切换排版插件，观察真实热替换与依赖重建。',
				'切换到 Typst 模板，调整字号、页宽或页边距。',
			].map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
		},
		{
			type: 'table',
			content: [
				{ type: 'tableRow', content: [cell('运行位置', true), cell('职责', true)] },
				{ type: 'tableRow', content: [cell('浏览器 Worker'), cell('Pluxel Core + Host')] },
				{ type: 'tableRow', content: [cell('Typst 插件'), cell('WASM 编译与排版')] },
			],
		},
	],
}

export const initialSource = `#set page(width: 145mm, height: auto, margin: 14mm)
#set text(font: "LXGW WenKai", size: 12pt)
#set heading(numbering: "1.")

#include "_editor/regions/body.typ"
`
