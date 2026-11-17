import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceEditor, prepareTypstSourceCopy } from '../src/tiptap/source-editor.js'

const bytes = (source: string) => new TextEncoder().encode(source).length
const all = (document: JSONContent): JSONContent[] => [
	document,
	...(document.content?.flatMap(all) ?? []),
]
function fixture(source: string) {
	return createTypstSourceProject({
		files: {
			'main.typ': source,
			'chapters/one.typ': '= 外部章节\n\n第一节正文。',
			'chapters/two.typ': '= 另一章节\n\n第二节正文。',
		},
	})
}

describe('native static include content', () => {
	it('projects one authored include without expanding its body and preserves source bytes on no-op', () => {
		const source = '// 原文保留\r\n#include /* 章节说明 */ "chapters/one.typ"\r\n\r\n正文😀。\r\n'
		const project = fixture(source),
			projection = project.open('main.typ')
		expect(projection.document.content![0]).toEqual({
			type: 'typstInclude',
			attrs: {
				module: 'chapters/one.typ',
				source: '#include /* 章节说明 */ "chapters/one.typ"',
			},
		})
		expect(all(projection.document).some((node) => node.type === 'heading')).toBe(false)
		expect(
			all(projection.document)
				.filter((node) => node.type === 'text')
				.map((node) => node.text)
				.join(''),
		).toBe('正文😀。')
		expect(project.edit({ projection, document: structuredClone(projection.document) }).ok).toBe(
			true,
		)
		expect(project.snapshot().files['main.typ']).toBe(source)
		expect(project.snapshot().files['chapters/one.typ']).toBe('= 外部章节\n\n第一节正文。')
	})

	it.each([
		'前文 #include /* 原注释 */ "chapters/one.typ"; 后文。\r\n',
		'#include /* 原注释 */ "chapters/one.typ"; 后文。\r\n',
		'前文 #include /* 原注释 */ "chapters/one.typ"\r\n后文。\r\n',
	])('keeps inline literal includes in their authored paragraph: %s', (source) => {
		const project = fixture(source),
			projection = project.open('main.typ')
		expect(projection.document.content).toHaveLength(1)
		expect(projection.document.content![0]!.type).toBe('paragraph')
		expect(all(projection.document).filter((node) => node.type === 'typstInclude')).toEqual([])
		expect(all(projection.document).filter((node) => node.type === 'typstInlineSource')).toEqual([
			{
				type: 'typstInlineSource',
				attrs: {
					role: 'environment',
					source: '#include /* 原注释 */ "chapters/one.typ"',
				},
			},
		])
		expect(project.edit({ projection, document: structuredClone(projection.document) }).ok).toBe(
			true,
		)
		expect(project.snapshot().files['main.typ']).toBe(source)
		const document = structuredClone(projection.document)
		const after = all(document).find((node) => node.type === 'text' && node.text?.includes('后文'))!
		after.text = after.text!.replace('后文', '更新后文')
		expect(project.edit({ projection, document }).ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(source.replace('后文', '更新后文'))
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(source)
	})

	it('keeps an unterminated inline include and its existing syntax diagnostic in place', () => {
		const source = '前文 #include "chapters/one.typ" 后文。'
		const project = fixture(source),
			projection = project.open('main.typ')
		expect(projection.document.content).toHaveLength(1)
		expect(all(projection.document).some((node) => node.type === 'typstInclude')).toBe(false)
		expect(projection.diagnostics.some((issue) => issue.message.includes('semicolon'))).toBe(true)
		expect(project.edit({ projection, document: structuredClone(projection.document) }).ok).toBe(
			true,
		)
		expect(project.snapshot().files['main.typ']).toBe(source)
	})

	it('patches only the literal module path, preserving comments, adjacent source and project history', () => {
		const source = '#include /* 保留注释 */ "chapters/one.typ"\r\n\r\n正文。\r\n'
		const project = fixture(source),
			projection = project.open('main.typ')
		const document = structuredClone(projection.document)
		document.content![0]!.attrs!.module = 'chapters/two.typ'
		expect(project.edit({ projection, document }).ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(source.replace('one.typ', 'two.typ'))
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(source)
		expect(project.redo().ok).toBe(true)
		expect(project.open('main.typ').document.content![0]!.attrs?.module).toBe('chapters/two.typ')
	})

	it('reorders same-type include nodes with their own comments and deletes them as ordinary content', () => {
		const first = '#include /* 第一节 */ "chapters/one.typ"'
		const second = '#include /* 第二节 */ "chapters/two.typ"'
		const source = `${first}\n\n${second}\n\n正文。`
		const project = fixture(source),
			projection = project.open('main.typ')
		const document = structuredClone(projection.document)
		;[document.content![0], document.content![1]] = [document.content![1]!, document.content![0]!]
		expect(project.edit({ projection, document }).ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(`${second}\n\n${first}\n\n正文。`)
		const moved = project.open('main.typ'),
			deleted = structuredClone(moved.document)
		deleted.content!.splice(0, 1)
		expect(project.edit({ projection: moved, document: deleted }).ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(`\n\n${first}\n\n正文。`)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(`${second}\n\n${first}\n\n正文。`)
	})

	it('supports native insertion, module editing, deletion, copying and undo', () => {
		const source = '原有正文。'
		const project = fixture(source),
			editor = createTypstSourceEditor({ project, path: 'main.typ' })
		try {
			expect(
				editor.commands.insertContentAt(0, {
					type: 'typstInclude',
					attrs: { module: 'chapters/one.typ' },
				}),
			).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe(`#include "chapters/one.typ"\n\n${source}`)
			editor.commands.setNodeSelection(0)
			expect(editor.commands.updateAttributes('typstInclude', { module: 'chapters/two.typ' })).toBe(
				true,
			)
			expect(project.snapshot().files['main.typ']).toBe(`#include "chapters/two.typ"\n\n${source}`)
			const copy = prepareTypstSourceCopy(editor, project, 'main.typ', 0)
			expect(copy).toBeDefined()
			editor.view.dispatch(copy!)
			expect(editor.getJSON().content!.filter((node) => node.type === 'typstInclude')).toHaveLength(
				2,
			)
			expect(editor.commands.undo()).toBe(true)
			editor.commands.setNodeSelection(0)
			expect(editor.commands.deleteSelection()).toBe(true)
			expect(editor.getJSON().content!.some((node) => node.type === 'typstInclude')).toBe(false)
			expect(editor.commands.undo()).toBe(true)
			expect(editor.getJSON().content!.filter((node) => node.type === 'typstInclude')).toHaveLength(
				1,
			)
		} finally {
			editor.destroy()
		}
	})

	it('rebases a copied literal include across files without copying or expanding the target chapter', () => {
		const source = '#include /* keep */ "../chapters/one.typ"'
		const files = {
			'sections/a.typ': source,
			'b.typ': '目标正文。',
			'chapters/one.typ': '= 唯一章节\n\n章节内容。',
		}
		const project = createTypstSourceProject({ files })
		expect(
			project.copy({
				baseRevision: 0,
				path: 'sections/a.typ',
				from: 0,
				to: bytes(source),
				toPath: 'b.typ',
				at: 0,
			}).ok,
		).toBe(true)
		expect(project.snapshot().files).toEqual({
			...files,
			'b.typ': '\n\n#include /* keep */ "chapters/one.typ"\n\n目标正文。',
		})
		expect(project.open('b.typ').document.content![0]!.type).toBe('typstInclude')
	})

	it('does not use static includes as variable-scope barriers while retaining dynamic and import barriers', () => {
		const figure = '#figure([A]) <fig:a>'
		for (const barrier of [
			'#include "chapters/one.typ"',
			'#include chapter',
			'#import "chapters/one.typ" as chapter',
		]) {
			const source = `${figure}\n\n${barrier}\n\n尾部。`
			const project = fixture(source)
			const result = project.move({
				baseRevision: 0,
				path: 'main.typ',
				label: 'fig:a',
				toPath: 'main.typ',
				at: bytes(source),
			})
			expect(result.ok).toBe(barrier === '#include "chapters/one.typ"')
		}
	})

	it('retains dynamic includes as fixed opaque source and keeps readonly structural admission', () => {
		const source = '#include chapter\n\n正文。'
		const project = createTypstSourceProject({ files: { 'main.typ': source }, writablePaths: [] })
		expect(project.open('main.typ').document.content![0]).toEqual({
			type: 'typstSource',
			attrs: { role: 'environment', source: '#include chapter' },
		})
		const issues: { code: string }[] = []
		const editor = createTypstSourceEditor({
			project,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			expect(editor.isEditable).toBe(false)
			editor.setEditable(true)
			editor.commands.insertContentAt(0, { type: 'typstInclude', attrs: { module: 'chapter.typ' } })
			expect(issues.at(-1)?.code).toBe('READ_ONLY')
			expect(project.snapshot().files['main.typ']).toBe(source)
		} finally {
			editor.destroy()
		}
	})

	it('keeps a template include readonly while the independently writable chapter remains editable', () => {
		const source = '#include "chapter.typ"\n'
		const project = createTypstSourceProject({
			files: { 'main.typ': source, 'chapter.typ': '章节正文。' },
			writablePaths: ['chapter.typ'],
		})
		const issues: { code: string }[] = []
		const template = createTypstSourceEditor({
			project,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		const chapter = createTypstSourceEditor({ project, path: 'chapter.typ' })
		try {
			expect(template.isEditable).toBe(false)
			template.setEditable(true)
			template.commands.setNodeSelection(0)
			template.commands.updateAttributes('typstInclude', { module: 'other.typ' })
			expect(issues.at(-1)?.code).toBe('READ_ONLY')
			expect(chapter.commands.insertContentAt(1, { type: 'text', text: '已更新：' })).toBe(true)
			expect(project.snapshot().files).toEqual({
				'main.typ': source,
				'chapter.typ': '已更新：章节正文。',
			})
		} finally {
			chapter.destroy()
			template.destroy()
		}
	})

	it('rejects empty module paths, derived-source mutation and malformed attributes atomically', () => {
		const source = '#include "chapters/one.typ"\n\n正文。'
		for (const attrs of [
			{ module: '' },
			{ module: 1 },
			{ source: '#include "other.typ"' },
			{ extra: 'unsupported' },
		]) {
			const project = fixture(source),
				projection = project.open('main.typ'),
				document = structuredClone(projection.document)
			Object.assign(document.content![0]!.attrs!, attrs)
			expect(project.edit({ projection, document }).ok).toBe(false)
			expect(project.snapshot().files['main.typ']).toBe(source)
		}
	})
})
