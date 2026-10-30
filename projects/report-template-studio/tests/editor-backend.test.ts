import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { studioFixture } from './studio-fixture.js'
it('compiles ordinary source snapshots and JSON through native navigation and PDF while preserving raw authored files', async () => {
	await using fixture = await studioFixture('Native source acceptance')
	const { studio, project } = fixture,
		target = { projectId: project.id, entry: '报表/客户服务报告/客户服务报告.ts' }
	const input = await studio.getInput(target),
		description = await studio.describeDocument(target)
	expect(description.editor?.sources).toHaveLength(2)
	const original = structuredClone(input),
		path = description.editor!.sources[0]!.path
	const edited = {
		...input,
		editor: {
			files: {
				...input.editor!.files,
				[path]: input.editor!.files[path] + '\nAuthored *source* comment // preserved\n',
			},
		},
	}
	const first = await studio.compile({
		...target,
		data: edited.data,
		editor: edited.editor,
		clientRevision: 3,
	})
	expect(first.diagnostics).toEqual([])
	expect(first.pageCount).toBeGreaterThan(0)
	const preview = await studio.getPreview(first)
	expect(preview.preview.navigation.points.some((point) => point.path === path)).toBe(true)
	expect(preview.preview.navigation.points.some((point) => point.path.startsWith('_editor/'))).toBe(
		false,
	)
	expect(await studio.getInput(target)).toEqual(original)
	const dataPath = '报表/客户服务报告/data.json'
	await expect(
		studio.compile({
			...target,
			data: edited.data,
			editor: { files: { ...edited.editor.files, [dataPath]: '{ broken' } },
			clientRevision: 4,
		}),
	).rejects.toMatchObject({ code: 'INVALID_INPUT' })
	await expect(
		studio.compile({
			...target,
			data: { ...edited.data, period: 'Different' },
			editor: edited.editor,
			clientRevision: 4,
		}),
	).rejects.toMatchObject({ code: 'INVALID_INPUT' })
	const retainedPreview = await studio.getPreview(first)
	expect(retainedPreview.revision).toBe(first.revision)
	expect(await studio.getInput(target)).toEqual(original)

	const pdfResult = await studio.exportPdf(first)
	const pdf = await readFile(pdfResult.path)
	expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
	const saved = await studio.setInput({
		...target,
		data: edited.data,
		editor: edited.editor,
		expectedVersion: input.storageVersion,
	})
	const savedSource = await studio.readFile({ projectId: project.id, path })
	expect(savedSource.content).toBe(edited.editor.files[path])
	expect(saved.editor!.files[path]).toContain('// preserved')
	const invalid = {
		...saved,
		editor: { files: { ...saved.editor!.files, [path]: '#let bad = (' } },
	}
	const invalidSaved = await studio.setInput({
		...target,
		data: invalid.data,
		editor: invalid.editor,
		expectedVersion: saved.storageVersion,
	})
	await expect(
		studio.compile({
			...target,
			data: invalidSaved.data,
			editor: invalidSaved.editor,
			clientRevision: 4,
		}),
	).rejects.toMatchObject({ code: 'COMPILE_FAILED' })
	expect(await studio.getInput(target)).toEqual(invalidSaved)
	await expect(studio.exportPdf(first)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
}, 120000)
