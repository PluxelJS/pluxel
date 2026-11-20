import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import {
	chapterPath,
	DocumentInputError,
	DocumentProject,
	documentAssetPath,
	documentDirectory,
	documentSeed,
} from './consumer/document-private/project'

const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const body = (model: DocumentProject, id: string) =>
	structuredClone(model.view().documents.find((entry) => entry.id === id)!.document)

describe('chapter document host', () => {
	it('publishes editable content with stable labels and echoes it without a new source revision', () => {
		const files = documentSeed()
		const model = new DocumentProject(files)
		const view = model.view()
		const wire = JSON.stringify(view)
		for (const privateValue of [
			'DOCUMENT_PRIVATE_SOURCE_',
			'inputs/chapters/',
			'.typ',
			'固定研究提示',
			'typstImport',
			'typstSource',
		])
			expect(wire).not.toContain(privateValue)
		expect(wire).toContain(documentAssetPath)
		expect(view.references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'chapter-approach',
					title: '研究方法',
					location: { documentId: 'approach', position: 0 },
				}),
				expect.objectContaining({ id: 'object-architecture', kind: 'figure' }),
			]),
		)
		for (const entry of view.documents) {
			model.edit(entry.id, { kind: 'tiptap', document: entry.document })
			model.edit(entry.id, { kind: 'typst', source: model.source(entry.id) })
		}
		expect(model.files()).toEqual(files)
		expect(model.revision).toBe(view.revision)
		expect(model.dirty).toBe(false)
		expect(model.view().canUndo).toBe(false)
	})

	it('uses one editable Typst chapter for source and rich-text edits, history and reopen', () => {
		const model = new DocumentProject(documentSeed())
		const baseline = model.files()
		model.edit('approach', {
			kind: 'typst',
			source: '新加入的 *引言*。\n\n' + model.source('approach'),
		})
		const first = model.files()
		const document = body(model, 'approach')
		expect(document.content![0]!.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: '引言', marks: [{ type: 'bold' }] }),
			]),
		)
		document.content![0] = paragraph('继续填写引言。')
		model.edit('approach', { kind: 'tiptap', document })
		const second = model.files()
		expect(second[chapterPath('approach')]).toContain('继续填写引言。')
		expect(Object.keys(second).sort()).toEqual(Object.keys(baseline).sort())
		expect(model.dirty).toBe(true)
		model.undo()
		expect(model.files()).toEqual(first)
		model.undo()
		expect(model.files()).toEqual(baseline)
		model.redo()
		model.redo()
		expect(model.files()).toEqual(second)
		const reopened = new DocumentProject(second).view()
		expect(reopened.documents).toEqual(model.view().documents)
		expect(reopened.references).toEqual(model.view().references)
	})

	it('rejects unknown structure, unsupported Typst and unapproved labels and assets atomically', () => {
		const model = new DocumentProject(documentSeed())
		const baseline = model.files()
		const document = body(model, 'background')
		const cases = [
			{
				kind: 'tiptap',
				document: {
					...document,
					content: [
						{ type: 'typstSource', attrs: { source: '#let editorial-note = 1' } },
						...document.content!,
					],
				},
			},
			{
				kind: 'tiptap',
				document: {
					...document,
					content: [{ type: 'paragraph', attrs: { path: 'main.typ' } }, ...document.content!],
				},
			},
			{ kind: 'typst', source: '#let editorial-note = 1\n可见正文。' },
			{ kind: 'typst', source: '见 #ref(<object-unpublished>)。' },
			{
				kind: 'typst',
				source: '#figure(image("/body-assets/unpublished.svg"), caption: [图示])',
			},
			{ kind: 'typst', source: '= 重复标签 <object-architecture>' },
		]
		for (const candidate of cases) {
			expect(() => model.edit('background', candidate)).toThrow(DocumentInputError)
			expect(model.files()).toEqual(baseline)
			expect(model.view().canUndo).toBe(false)
		}
	})

	it('creates, names and reorders chapters as individual project history entries', () => {
		const model = new DocumentProject(documentSeed())
		const document = body(model, 'background')
		document.content!.push(paragraph('先前已经接纳的内容。'))
		model.edit('background', { kind: 'tiptap', document })
		const prior = model.files()
		const revision = model.revision
		model.create('review', '成果复核')
		expect(model.revision).toBe(revision + 1)
		expect(model.view().documents.at(-1)?.title).toBe('成果复核')
		expect(model.files()[chapterPath('review')]).toContain('请在这里撰写正文。')
		model.undo()
		expect(model.files()).toEqual(prior)
		model.redo()
		model.rename('review', '复核与交付')
		const { [documentDirectory]: beforeDirectory, ...beforeChapters } = model.files()
		model.reorder(['background', 'review', 'approach', 'schedule'])
		expect(model.view().documents.map(({ id }) => id)).toEqual([
			'background',
			'review',
			'approach',
			'schedule',
		])
		expect(model.view().references).toContainEqual(
			expect.objectContaining({ id: 'chapter-review', title: '复核与交付' }),
		)
		const { [documentDirectory]: afterDirectory, ...afterChapters } = model.files()
		expect(afterDirectory).not.toBe(beforeDirectory)
		expect(afterChapters).toEqual(beforeChapters)
		model.markSaved()
		expect(model.dirty).toBe(false)
		model.undo()
		expect(model.dirty).toBe(true)
		model.redo()
		expect(model.dirty).toBe(false)
	})

	it('rejects invalid metadata and stale revisions without altering any chapter', () => {
		const model = new DocumentProject(documentSeed())
		const baseline = model.files()
		for (const action of [
			() => model.create('../outside', '无效'),
			() => model.create('background', '重复'),
			() => model.rename('background', ''),
			() => model.reorder(['background', 'approach', 'approach']),
			() => model.checkRevision(99),
			() => model.edit('../outside', { kind: 'typst', source: '无效' }),
		])
			expect(action).toThrow(DocumentInputError)
		expect(model.files()).toEqual(baseline)
	})
})
