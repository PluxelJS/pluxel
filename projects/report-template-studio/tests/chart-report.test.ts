import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { studioFixture } from './studio-fixture.js'
it('retains chart parameters, data, equations, caption references and native table/source content in ordinary files', async () => {
	await using fixture = await studioFixture('Chart source acceptance')
	const { studio, project } = fixture,
		target = { projectId: project.id, entry: '报表/图表分析报告/图表分析报告.ts' }
	const input = await studio.getInput(target),
		description = await studio.describeDocument(target),
		path = '报表/图表分析报告/analysis.typ'
	expect(description.editor?.components?.[0]).toMatchObject({
		name: 'channels',
		parameters: { title: { type: 'string' } },
	})
	const core = createTypstSourceProject({
		files: input.editor!.files,
		components: description.editor!.components,
	})
	const projection = core.open(path)
	expect(JSON.stringify(projection.document)).toContain('typstComponent')
	expect(JSON.stringify(projection.document)).toContain('blockMath')
	const first = await studio.compile({ ...target, ...input, clientRevision: 1 })
	expect(first.diagnostics).toEqual([])
	const page = await studio.renderPage({ ...first, page: 1 })
	const png = await readFile(page.path)
	expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	const sample = await studio.readFile({
		projectId: project.id,
		path: '报表/图表分析报告/示例输入.json',
	})
	const data = JSON.parse(sample.content),
		saved = await studio.setInput({
			...target,
			data,
			editor: input.editor,
			expectedVersion: input.storageVersion,
		})
	const second = await studio.compile({ ...target, ...saved, clientRevision: 2 })
	expect(second.data.channels).toHaveLength(3)
	expect(saved.editor!.files[path]).toBe(input.editor!.files[path])
	expect(
		core.renameLabel({ baseRevision: core.revision, from: 'fig:channels', to: 'fig:revenue' }).ok,
	).toBe(true)
	const renamed = core.snapshot().files as Record<string, string>
	expect(renamed['报表/图表分析报告/actions.typ']).toContain('@fig:revenue')
	// Merge the independently accepted JSON revision with the explicit label transaction.
	const editor = {
		files: {
			...saved.editor!.files,
			[path]: renamed[path]!,
			'报表/图表分析报告/actions.typ': renamed['报表/图表分析报告/actions.typ']!,
		},
	}
	const renamedSaved = await studio.setInput({
		...target,
		data,
		editor,
		expectedVersion: saved.storageVersion,
	})
	const third = await studio.compile({ ...target, ...renamedSaved, clientRevision: 3 })
	expect(third.diagnostics).toEqual([])
	const preview = await studio.getPreview(third)
	expect(
		preview.preview.navigation.points.some((point) => point.path === '报表/图表分析报告/chart.typ'),
	).toBe(true)
}, 120000)
