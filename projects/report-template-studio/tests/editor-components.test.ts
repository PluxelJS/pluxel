import { expect, it } from 'vitest'
import { describeEditor, validateEditorDraft } from '../src/backend/editor-config.js'
import type { EditorDraft, WorkspaceSnapshot } from '../src/shared/contracts.js'

const components = {
	regions: [{ id: 'body' }],
	fields: [],
	templates: [
		{ id: 'channels', label: '渠道收入', source: '#props.title', defaults: { title: '收入' } },
	],
	sourceBlocks: true,
	defaults: {
		body: {
			type: 'doc',
			content: [
				{
					type: 'templateBlock',
					attrs: {
						id: 'chart-1',
						template: 'channels',
						props: { title: '渠道收入' },
						dataPath: ['channels'],
					},
				},
				{ type: 'typstSource', attrs: { id: 'note-1', source: '#text(size: 8pt)[补充口径]' } },
			],
		},
	},
}
function snapshot(config: unknown): WorkspaceSnapshot {
	return {
		project: { id: 'test', name: 'Test', root: '/test' },
		revision: 'revision-1',
		config: { name: 'Test', fonts: [] },
		assets: [],
		files: { 'report.editor.json': JSON.stringify(config) },
	}
}

it('exposes only serializable component definitions and explicitly enabled source blocks', () => {
	const description = describeEditor(snapshot(components), 'report.ts')!
	expect(description.templates).toEqual(components.templates)
	expect(description.sourceBlocks).toBe(true)
	const draft: EditorDraft = {
		formatVersion: 1,
		templateId: description.templateId,
		templateRevision: description.templateRevision,
		regions: description.defaults,
	}
	expect(validateEditorDraft(description, draft, { channels: [] })).toEqual(draft)
	expect(() => validateEditorDraft(description, draft, {})).toThrowError(
		expect.objectContaining({ code: 'INVALID_EDITOR_DRAFT' }),
	)
	for (const change of [
		{ sourceBlocks: false },
		{ templates: [] },
		{ templates: [{ ...components.templates[0], validateProps: 'untrusted callback' }] },
		{ templates: [{ ...components.templates[0], defaults: [] }] },
		{ templates: [{ ...components.templates[0], id: '../escape' }] },
		{ templates: [components.templates[0], components.templates[0]] },
	]) {
		expect(() => describeEditor(snapshot({ ...components, ...change }), 'report.ts')).toThrowError(
			expect.objectContaining({ code: 'INVALID_EDITOR_CONFIG' }),
		)
	}
	expect(draft.regions).toEqual(components.defaults)
})

it('keeps the editor schema ordinary when a report does not install component or source extensions', () => {
	const description = describeEditor(
		snapshot({
			regions: components.regions,
			fields: [],
			defaults: { body: { type: 'doc', content: [{ type: 'paragraph' }] } },
		}),
		'report.ts',
	)!
	expect(description.templates).toBeUndefined()
	expect(description.sourceBlocks).toBeUndefined()
	expect(() =>
		validateEditorDraft(description, {
			formatVersion: 1,
			templateId: description.templateId,
			templateRevision: description.templateRevision,
			regions: components.defaults,
		}),
	).toThrowError(expect.objectContaining({ code: 'INVALID_EDITOR_DRAFT' }))
})
