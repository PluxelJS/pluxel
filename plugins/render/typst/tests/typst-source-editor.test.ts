import { describe, expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceEditor } from '../src/tiptap/source-editor.js'

describe('native source editor', () => {
	it('keeps template structure fixed while body and shared data remain writable', () => {
		const files = {
			'main.typ': '= 固定标题\n#include "body.typ"\n',
			'body.typ': '可编辑正文。\n',
			'data.json': '{"company":"原公司"}',
		}
		const project = createTypstSourceProject({ files, writablePaths: ['body.typ', 'data.json'] })
		const issues: { code: string }[] = []
		const template = createTypstSourceEditor({
			project,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		const body = createTypstSourceEditor({ project, path: 'body.typ' })
		try {
			expect(project.isWritable('main.typ')).toBe(false)
			expect(project.isWritable('missing.typ')).toBe(false)
			expect(project.isWritable('body.typ')).toBe(true)
			expect(template.isEditable).toBe(false)
			// A caller changing the native view flag cannot bypass project admission.
			template.setEditable(true)
			template.commands.insertContentAt(1, { type: 'text', text: '越权修改' })
			expect(issues.at(-1)?.code).toBe('READ_ONLY')
			body.commands.insertContentAt(1, { type: 'text', text: '更新：' })
			expect(
				project.apply({
					baseRevision: project.revision,
					patches: [
						{
							path: 'data.json',
							from: 0,
							to: new TextEncoder().encode(files['data.json']).length,
							text: '{"company":"新公司"}',
						},
					],
				}).ok,
			).toBe(true)
			expect(project.snapshot().files).toEqual({
				...files,
				'body.typ': '更新：可编辑正文。\n',
				'data.json': '{"company":"新公司"}',
			})
		} finally {
			body.destroy()
			template.destroy()
		}
	})

	it('accepts Chinese edits into source, preserves surrounding bytes, and owns undo/redo in the project', () => {
		const source = '// 保留\r\n\r\n开始😀e\u0301 #unknown[原样] 结束\r\n'
		const project = createTypstSourceProject({ files: { 'main.typ': source } })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			expect(project.snapshot().files['main.typ']).toBe(source)
			editor.commands.insertContentAt(1, { type: 'text', text: '人工修改：' })
			expect(issues).toEqual([])
			expect(project.snapshot().files['main.typ']).toBe(source.replace('开始', '人工修改：开始'))
			expect(editor.getText()).toContain('人工修改')
			expect(editor.commands.undo()).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe(source)
			expect(editor.commands.redo()).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe(source.replace('开始', '人工修改：开始'))
		} finally {
			editor.destroy()
		}
	})

	it('rejects an old editor transaction after an external source replacement', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': '原始正文' } })
		const issues: { code: string }[] = []
		const editor = createTypstSourceEditor({
			project,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			const old = editor.state.tr.insertText('过期修改', 1)
			expect(project.replace({ baseRevision: 0, files: { 'main.typ': 'Agent 最新正文' } }).ok).toBe(
				true,
			)
			editor.view.dispatch(old)
			expect(project.snapshot().files['main.typ']).toBe('Agent 最新正文')
			expect(editor.getText()).toContain('Agent 最新正文')
			expect(issues.at(-1)?.code).toBe('CONFLICT')
		} finally {
			editor.destroy()
		}
	})

	it('renames figure labels and cross-file native references as one undoable editor operation', () => {
		const files = {
			'analysis.typ': '#figure(image("logo.svg"), caption: [原题注]) <fig:before>\n',
			'actions.typ': '请参阅 @fig:before。\n',
		}
		const project = createTypstSourceProject({ files })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project,
			path: 'analysis.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			expect(editor.state.doc.firstChild?.type.name).toBe('figure')
			editor.view.dispatch(
				editor.state.tr.setNodeMarkup(0, undefined, {
					...editor.state.doc.firstChild!.attrs,
					label: 'fig:after',
				}),
			)
			expect(issues).toEqual([])
			expect(project.snapshot().files['analysis.typ']).toContain('<fig:after>')
			expect(project.snapshot().files['actions.typ']).toContain('@fig:after')
			editor.commands.undo()
			expect(project.snapshot().files).toEqual(files)
		} finally {
			editor.destroy()
		}
	})
})
