import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import {
	DocumentInputError,
	DocumentProject,
	documentDirectory,
	documentEntry,
	documentSeed,
	documentSourceCanary,
} from './consumer/document-private/project'

const text = (value: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text: value }],
})
const chapter = (model: DocumentProject, id: string) =>
	model.view().documents.find((entry) => entry.id === id)!
const sourcePath = (id: string) => `private-proposal/chapters/${id}.typ`

describe('private document host', () => {
	it('sends semantic content without private source, preserves source bytes on a no-op edit', async () => {
		const files = await documentSeed()
		const model = new DocumentProject(files)
		const view = model.view()
		const wire = JSON.stringify(view)
		for (const value of [
			documentSourceCanary,
			'private-proposal',
			'.typ',
			'#import',
			'typstImport',
			'typstSource',
			'architecture.svg',
			'"label":',
		])
			expect(wire).not.toContain(value)
		expect(view.references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: '研究方法',
					location: { documentId: 'approach', position: 0 },
				}),
				expect.objectContaining({ kind: 'figure' }),
			]),
		)
		for (const entry of view.documents) model.edit(entry.id, entry.document)
		expect(model.files()).toEqual(files)
		expect(model.dirty).toBe(false)
		expect(model.project.canUndo).toBe(false)
	})

	it('accepts repeated edits around protected content without changing its identity or template', async () => {
		const model = new DocumentProject(await documentSeed())
		const baseline = model.files()
		const first = chapter(model, 'approach').document
		const before = JSON.stringify(first).match(/"key":"([a-f0-9]+)"/g)
		first.content!.unshift(text('新加入的引言。'))
		model.edit('approach', first)
		const next = chapter(model, 'approach').document
		expect(JSON.stringify(next).match(/"key":"([a-f0-9]+)"/g)).toEqual(before)
		first.content![0] = text('继续填写引言，并保留固定研究提示。')
		model.edit('approach', first)
		expect(String(model.files()[sourcePath('approach')])).toContain(
			'继续填写引言，并保留固定研究提示。',
		)
		expect(String(model.files()[sourcePath('approach')])).toContain('#upper("固定研究提示")')
		expect(model.files()[documentEntry]).toBe(baseline[documentEntry])
		expect(model.dirty).toBe(true)
		model.undo()
		model.undo()
		expect(model.files()).toEqual(baseline)
		model.redo()
		model.redo()
		expect(chapter(model, 'approach').document.content![0]).toEqual(
			text('继续填写引言，并保留固定研究提示。'),
		)
	})

	it('rejects raw nodes, private attributes, forged or removed fixed content atomically', async () => {
		const model = new DocumentProject(await documentSeed())
		const baseline = model.files()
		const original = chapter(model, 'approach').document
		const opaqueIndex = original.content!.findIndex((node) => node.type === 'documentBlock')
		expect(opaqueIndex).toBeGreaterThanOrEqual(0)
		const cases = [
			{
				...original,
				content: [...original.content!, { type: 'typstSource', attrs: { source: '#panic()' } }],
			},
			{
				...original,
				content: [
					text('ordinary'),
					{ type: 'paragraph', attrs: { path: 'private-proposal/main.typ' } },
					...original.content!,
				],
			},
			{ ...original, content: original.content!.filter((_, index) => index !== opaqueIndex) },
			{
				...original,
				content: original.content!.map((node, index) =>
					index === opaqueIndex
						? { type: 'documentBlock', attrs: { key: 'forged', title: '固定内容' } }
						: node,
				),
			},
		]
		for (const document of cases) {
			expect(() => model.edit('approach', document)).toThrow(DocumentInputError)
			expect(model.files()).toEqual(baseline)
			expect(model.project.canUndo).toBe(false)
		}
	})

	it('creates, names and reorders actual chapters as individual project history entries', async () => {
		const model = new DocumentProject(await documentSeed())
		const edited = chapter(model, 'background').document
		edited.content!.push(text('先前已经接纳的内容。'))
		model.edit('background', edited)
		const prior = model.files()
		const revision = model.revision
		model.create('review', '成果复核')
		expect(model.revision).toBe(revision + 1)
		expect(model.view().documents.at(-1)?.title).toBe('成果复核')
		expect(model.files()[sourcePath('review')]).toContain('请在这里撰写正文。')
		model.undo()
		expect(model.files()).toEqual(prior)
		model.redo()
		model.rename('review', '复核与交付')
		const beforeOrder = model.files()
		model.reorder(['background', 'review', 'approach', 'schedule'])
		expect(model.view().documents.map(({ id }) => id)).toEqual([
			'background',
			'review',
			'approach',
			'schedule',
		])
		for (const [path, value] of Object.entries(beforeOrder).filter(
			([candidate]) => candidate !== documentDirectory,
		))
			expect(model.files()[path]).toEqual(value)
		model.markSaved()
		expect(model.dirty).toBe(false)
		model.undo()
		expect(model.dirty).toBe(true)
		model.redo()
		expect(model.dirty).toBe(false)
	})

	it('rejects invalid metadata and stale revisions without altering any chapter', async () => {
		const model = new DocumentProject(await documentSeed())
		const baseline = model.files()
		for (const action of [
			() => model.create('../outside', '无效'),
			() => model.create('background', '重复'),
			() => model.rename('background', ''),
			() => model.reorder(['background', 'approach', 'approach']),
			() => model.checkRevision(99),
			() => model.edit('../outside', text('无效')),
		])
			expect(action).toThrow(DocumentInputError)
		expect(model.files()).toEqual(baseline)
	})
})
