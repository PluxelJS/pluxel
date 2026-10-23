import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '@pluxel/test'
import { nodeModules } from '@pluxel/services/node'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { findTypstGeneratedPosition, findTypstRegionPosition } from '@pluxel/plugin-typst/tiptap'
import { DocumentSession } from '../../../plugins/render/typst/src/session.ts'
import { StudioPlugin } from '../src/backend/plugin.js'
import type { EditorDraft, JsonObject } from '../src/shared/contracts.js'

it('compiles movable chart components and source blocks from external input without replacing editable analysis', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-chart-report-'))
	const updates: Parameters<DocumentSession['update']>[0][] = []
	const originalUpdate = DocumentSession.prototype.update
	const update = vi.spyOn(DocumentSession.prototype, 'update').mockImplementation(function (
		this: DocumentSession,
		input,
	) {
		updates.push(input)
		return originalUpdate.call(this, input)
	})
	try {
		await using host = await createTestHost({ services: [nodeModules()] })
		await host.commit((change) => {
			change.catalog.add([FontsPlugin, TypstPlugin, StudioPlugin])
			change.start(FontsPlugin, { initialConfig: { maxFontBytes: 32 * 1024 * 1024 } })
			change.start(TypstPlugin, {
				initialConfig: { maxTemplateBytes: 128 * 1024 * 1024, maxFontBytes: 96 * 1024 * 1024 },
			})
			change.start(StudioPlugin, {
				initialConfig: { root, assetsRoot: resolve('financial-document-assets') },
			})
		})
		const studio = host.require(StudioPlugin)
		const project = await studio.createProject({ name: 'Chart report acceptance' })
		const target = { projectId: project.id, entry: '报表/图表分析报告/图表分析报告.ts' }
		const description = await studio.describeDocument(target)
		expect(description.editor?.table).toEqual({
			defaultStyle: 'three-line',
			allowedStyles: ['grid', 'grid-open-sides', 'three-line', 'borderless'],
		})
		expect(description.editor?.templates?.map((template) => template.id)).toEqual([
			'channel-performance',
		])
		expect(description.editor?.sourceBlocks).toBe(true)
		const editor: EditorDraft = {
			formatVersion: 1,
			templateId: description.editor!.templateId,
			templateRevision: description.editor!.templateRevision,
			regions: structuredClone(description.editor!.defaults),
		}
		const defaults = await studio.compile({ ...target, data: {}, editor, clientRevision: 0 })
		expect(defaults.data.channels).toHaveLength(4)
		expect(defaults.diagnostics).toEqual([])
		const sample = await studio.readFile({
			projectId: project.id,
			path: '报表/图表分析报告/示例输入.json',
		})
		const data = JSON.parse(sample.content) as JsonObject
		const saved = await studio.setInput({ ...target, data, editor, expectedVersion: null })
		const first = await studio.compile({ ...target, data, editor, clientRevision: 1 })
		expect(first.data).toEqual(data)
		expect(first.data.channels).toHaveLength(3)
		const preview = await studio.getPreview(first)
		const chartMapping = preview.generatedMapping!.find((mapping) =>
			mapping.path.endsWith('/channel-chart.typ'),
		)!
		expect(chartMapping.kind).toBe('atom')
		const chartPoint = preview.preview.navigation.points.find(
			(point) => point.path === chartMapping.path,
		)!
		expect(chartPoint).toBeDefined()
		expect(
			findTypstRegionPosition({
				mapping: preview.generatedMapping!,
				position: chartPoint,
				snapshotRevision: 1,
			}),
		).toMatchObject({ regionId: 'analysis', from: chartMapping.from, to: chartMapping.to })
		expect(
			findTypstGeneratedPosition({
				mapping: preview.generatedMapping!,
				navigation: preview.preview.navigation,
				regionId: 'analysis',
				position: chartMapping.from,
				snapshotRevision: 1,
			})?.path,
		).toBe(chartMapping.path)
		expect(
			preview.generatedMapping!.some((mapping) => mapping.path.endsWith('/analysis-note.typ')),
		).toBe(true)
		expect(preview.generatedMapping?.some((mapping) => mapping.regionId === 'actions')).toBe(true)
		expect(
			preview.preview.navigation.points.some(
				(point) => point.path === '报表/图表分析报告/排版.typ',
			),
		).toBe(true)
		const firstPage = await studio.renderPage({ ...first, page: 1, scale: 1 })
		const firstPng = await readFile(firstPage.path)
		const output = resolve('test-results/chart-report')
		await mkdir(output, { recursive: true })
		await writeFile(join(output, 'external-input.png'), firstPng)
		const dataOnly = structuredClone(data)
		const channels = dataOnly.channels as JsonObject[]
		channels[0]!.actual = 80
		channels[1]!.target = 0
		channels[2]!.actual = 0
		const second = await studio.compile({ ...target, data: dataOnly, editor, clientRevision: 2 })
		expect(second.diagnostics).toEqual([])
		expect(updates.at(-1)?.template).toBeUndefined()
		expect(updates.at(-1)?.files['/inputs/editor/data.json']).toMatchObject({
			kind: 'text',
			text: expect.stringContaining('"actual":80'),
		})
		const secondPreview = await studio.getPreview(second)
		expect(secondPreview.preview.sessionId).toBe(preview.preview.sessionId)
		const secondPage = await studio.renderPage({ ...second, page: 1, scale: 1 })
		const secondPng = await readFile(secondPage.path)
		await writeFile(join(output, 'data-update.png'), secondPng)
		expect(secondPng.equals(firstPng)).toBe(false)
		expect(editor.regions).toEqual(description.editor!.defaults)
		expect(await studio.getInput(target)).toEqual(saved)

		const styled = structuredClone(editor)
		const actionTable = styled.regions.actions!.content![0]!
		expect(actionTable.attrs?.typstTableStyle).toBe('three-line')
		actionTable.attrs!.typstTableStyle = 'borderless'
		const third = await studio.compile({
			...target,
			data: dataOnly,
			editor: styled,
			clientRevision: 3,
		})
		expect(third.diagnostics).toEqual([])
		expect(updates.at(-1)?.template).toBeDefined()
		expect(actionTable.content).toEqual(editor.regions.actions!.content![0]!.content)
		const thirdPage = await studio.renderPage({ ...third, page: 1, scale: 1 })
		const thirdPng = await readFile(thirdPage.path)
		expect(thirdPng.equals(secondPng)).toBe(false)
		const reordered = structuredClone(styled)
		const analysis = reordered.regions.analysis!.content!
		const [chart] = analysis.splice(1, 1)
		analysis.splice(2, 0, chart!)
		const fourth = await studio.compile({
			...target,
			data: dataOnly,
			editor: reordered,
			clientRevision: 4,
		})
		expect(fourth.diagnostics).toEqual([])
		const reorderedPreview = await studio.getPreview(fourth)
		const reorderedChart = reorderedPreview.generatedMapping!.find(
			(mapping) => mapping.path === chartMapping.path,
		)!
		expect(reorderedChart.from).toBeGreaterThan(chartMapping.from)
		expect(analysis[2]).toEqual(editor.regions.analysis!.content![1])
		expect(await studio.getInput(target)).toEqual(saved)
		const pdf = await studio.exportPdf(fourth)
		const pdfBytes = await readFile(pdf.path)
		expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
		expect(pdf.revision).toBe(fourth.revision)
		await expect(
			studio.compile({
				...target,
				data: { ...dataOnly, channels: [] },
				editor: styled,
				clientRevision: 5,
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(await studio.getInput(target)).toEqual(saved)

		await writeFile(join(output, 'external-input.png'), firstPng)
		await writeFile(join(output, 'data-update.png'), secondPng)
		await writeFile(join(output, 'borderless.png'), thirdPng)
		await writeFile(join(output, 'report.pdf'), pdfBytes)
	} finally {
		update.mockRestore()
		await rm(root, { recursive: true, force: true })
	}
})
