import { access, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const owner = `
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import type { Workbench } from '@pluxel/workbench'
import { Tools } from './views'
const WorkbenchRef = defineServiceRef<Workbench>()
@Plugin() export class Editor extends BasePlugin {
	init() {
		const publication = this.ctx.service(WorkbenchRef)?.publish(Tools, bindings)
		publication?.link('guide')
	}
}
@Plugin() export class Empty extends BasePlugin {}
throw new Error('OWNER_MUST_NOT_EXECUTE')
`
const views = `
import { workbench } from '@pluxel/workbench'
import type { SelectionApi as Selection } from './api'
import { picker } from './helper'
export const Tools = workbench.define(import.meta.url, {
	picker: picker(),
	local: workbench.attachment<Catalog, Selection>({ renderer: './ui.tsx' }),
	explicit: workbench.attachment<Catalog, never>({ renderer: './ui.tsx' }),
	guide: workbench.content({ document: './not-needed.md', placement: { kind: 'tab' } }),
	editor: workbench.view<EditorApi>({ renderer: './ui.tsx', placement: { kind: 'route', title: 'Edit', path: '/edit/:item' } }),
})
export type { Tools as ATypeOnlyName }
throw new Error('DEFINITION_MUST_NOT_EXECUTE')
`
const files = {
	'package.json': JSON.stringify({
		name: '@fixture/editor',
		exports: { '.': './editor.ts', './public': './public.ts', './types': './types.ts' },
	}),
	'editor.ts': owner,
	'views.ts': views,
	'api.ts': 'export interface SelectionApi { set(value: string): void }',
	'public.ts': "export { Tools as EditorUI } from './views'",
	'types.ts': "export type { Tools } from './views'",
	'helper.ts':
		"import { workbench } from '@pluxel/workbench'; export const picker = () => workbench.attachment<Catalog>({ renderer: './picker.tsx' })",
}
const include = ['workbench'] as const
describe('Workbench source inspection', () => {
	it('reports the selected owner, verified public value imports, roles and helper origins without building or executing modules', async () => {
		await using fixture = await createFixture(files)
		const options = { root: fixture.path, include }
		const report = await inspectPlugin('package:@fixture/editor::Editor', options)
		expect(report.data.sections.workbench).toMatchObject({
			status: 'complete',
			value: {
				publication: {
					exportName: 'Tools',
					imports: [{ module: '@fixture/editor/public', exportName: 'EditorUI' }],
					declaration: { file: fixture.getPath('views.ts') },
					entries: [
						{
							key: 'picker',
							kind: 'attachment',
							consumerApi: 'none',
							declaration: { file: fixture.getPath('helper.ts') },
						},
						{ key: 'local', kind: 'attachment', consumerApi: 'required' },
						{ key: 'explicit', kind: 'attachment', consumerApi: 'none' },
						{ key: 'guide', kind: 'content', placement: { kind: 'tab', order: 0 } },
						{ key: 'editor', kind: 'view', placement: { kind: 'route', path: '/edit/:item' } },
					],
				},
			},
		})
		const empty = await inspectPlugin('package:@fixture/editor::Empty', options)
		expect(empty.data.sections.workbench).toEqual({
			status: 'complete',
			value: { publication: null },
		})
		await expect(access(fixture.getPath('.pluxel/workbench-generated'))).rejects.toMatchObject({
			code: 'ENOENT',
		})
	})

	it('lists the named export of a star barrel and ignores its private default', async () => {
		await using fixture = await createFixture({
			...files,
			'views.ts': views + '\nexport default Tools',
			'barrel.ts': "export * from './views'",
			'public.ts': "export { Tools as EditorUI, default as Missing } from './barrel'",
		})
		const report = await inspectPlugin('package:@fixture/editor::Editor', {
			root: fixture.path,
			include,
		})
		expect(report.data.sections.workbench).toMatchObject({
			value: {
				publication: { imports: [{ module: '@fixture/editor/public', exportName: 'EditorUI' }] },
			},
		})
	})

	it('retains independent public imports when another re-export cannot be resolved', async () => {
		await using fixture = await createFixture({
			...files,
			'public.ts':
				"export { Unknown } from 'not-installed'; export { Tools as EditorUI } from './views'",
		})
		const report = await inspectPlugin('package:@fixture/editor::Editor', {
			root: fixture.path,
			include,
		})
		expect(report.data.sections.workbench).toMatchObject({
			status: 'partial',
			value: {
				publication: { imports: [{ module: '@fixture/editor/public', exportName: 'EditorUI' }] },
			},
			gaps: [{ code: 'unresolved_workbench_export', file: fixture.getPath('public.ts') }],
		})
	})

	it('locates application-local definitions and reports unprovable type arguments with their source', async () => {
		await using fixture = await createFixture({
			...files,
			'package.json': '{"private":true}',
			'views.ts':
				views.replace('Catalog, Selection>', 'Catalog, Maybe<Selection>>') +
				'\ntype Maybe<T> = T extends object ? never : T',
		})
		const options = { root: fixture.path, application: { root: '.', entry: 'editor.ts' }, include }
		const target = 'source:app/editor.ts::Editor'
		const report = await inspectPlugin(target, options)
		const section = report.data.sections.workbench
		expect(section).toMatchObject({
			status: 'partial',
			value: {
				publication: {
					imports: [],
					exportName: 'Tools',
					declaration: { file: fixture.getPath('views.ts') },
					entries: expect.arrayContaining([
						{
							key: 'local',
							kind: 'attachment',
							consumerApi: 'unknown',
							declaration: expect.any(Object),
						},
					]),
				},
			},
			gaps: [
				{
					code: 'unresolved_attachment_consumer',
					file: fixture.getPath('views.ts'),
					location: { start: { line: 7 } },
				},
			],
		})
		await writeFile(
			fixture.getPath('views.ts'),
			views.replace('workbench.define(import.meta.url, {', 'buildTopology({'),
		)
		const invalid = await inspectPlugin(target, options)
		expect(invalid.data.sections.workbench).toMatchObject({
			status: 'unavailable',
			reason: { code: 'unresolved_workbench_publication' },
		})
	})
})
