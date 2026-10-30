import { expect, it } from 'vitest'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { describeEditor, validateEditorDraft } from '../src/backend/editor-config.js'
import type { WorkspaceSnapshot } from '../src/shared/contracts.js'
function snapshot(config: unknown): WorkspaceSnapshot {
	return {
		project: { id: 'test', name: 'Test', root: '/test' },
		revision: 'r1',
		config: { name: 'Test', fonts: [] },
		assets: [],
		files: {
			'report/report.editor.json': JSON.stringify(config),
			'report/workspace.typ':
				'#import "chart.typ" as chart\n#chart.chart(title: "Sales", data: json("data.json"))\n',
			'report/chart.typ': '#let chart(title: "", data: (:)) = [#title]',
			'report/data.json': '{"sales":[1,2]}',
		},
	}
}
const config = {
	sources: [{ path: 'workspace.typ', label: 'Body' }],
	components: [
		{
			module: 'chart.typ',
			name: 'chart',
			label: 'Chart',
			parameters: { title: { type: 'string' } },
			data: 'data',
		},
	],
}
it('projects declared literal component parameters and JSON provenance from ordinary files', () => {
	const input = snapshot(config),
		description = describeEditor(input, 'report/report.ts')!
	expect(description.sources).toEqual([{ path: 'report/workspace.typ', label: 'Body' }])
	expect(description.components?.[0]?.module).toBe('report/chart.typ')
	expect(description.components?.[0]?.data).toBe('data')
	const project = createTypstSourceProject({
		files: input.files,
		components: description.components,
	})
	expect(JSON.stringify(project.open('report/workspace.typ').document)).toContain('typstComponent')
	expect(validateEditorDraft(description, { files: input.files })).toEqual({ files: input.files })
	for (const bad of [
		{ ...config, sourceBlocks: true },
		{ ...config, sources: [{ path: 'missing.typ' }] },
		{ ...config, sources: [{ path: 'workspace.typ' }, { path: 'workspace.typ' }] },
		{ ...config, components: [{ ...config.components[0], serialize: 'untrusted' }] },
	])
		expect(() => describeEditor(snapshot(bad), 'report/report.ts')).toThrow(
			/editor configuration|Editable source paths/,
		)
	expect(() => validateEditorDraft(description, { regions: { body: { type: 'doc' } } })).toThrow(
		'Editor drafts contain ordinary source files only',
	)
})
