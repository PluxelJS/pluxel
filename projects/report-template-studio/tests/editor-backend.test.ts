import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '@pluxel/test'
import { nodeModules } from '@pluxel/services/node'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { DocumentSession } from '../../../plugins/render/typst/src/session.ts'
import { StudioPlugin } from '../src/backend/plugin.js'
import { WorkspaceStore } from '../src/backend/store.js'
import { describeEditor, validateEditorDraft } from '../src/backend/editor-config.js'
import type { EditorDraft, WorkspaceSnapshot } from '../src/shared/contracts.js'

it('runs the Studio region draft through schema, native preview, navigation and same-revision PDF without mutating sources or raw input', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-editor-native-'))
	const snapshots: string[] = []
	const nativeRoots: string[] = []
	const generatedSources: Record<string, string>[] = []
	const updates: Parameters<DocumentSession['update']>[0][] = []
	const originalMaterialize = WorkspaceStore.prototype.materialize
	const materialize = vi
		.spyOn(WorkspaceStore.prototype, 'materialize')
		.mockImplementation(async function (this: WorkspaceStore, id, path) {
			snapshots.push(path)
			return originalMaterialize.call(this, id, path)
		})
	const originalInitialize = DocumentSession.prototype.initialize
	const initialize = vi
		.spyOn(DocumentSession.prototype, 'initialize')
		.mockImplementation(async function (this: DocumentSession, template, fonts, options) {
			nativeRoots.push(template.root)
			try {
				generatedSources.push(
					Object.fromEntries(
						await Promise.all(
							['summary', 'recommendations'].map(async (id) => [
								id,
								await readFile(join(template.root, `_editor/regions/${id}.typ`), 'utf8'),
							]),
						),
					),
				)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			}
			return originalInitialize.call(this, template, fonts, options)
		})
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
		const project = await studio.createProject({ name: 'Region editing acceptance' })
		const target = { projectId: project.id, entry: '报表/客户服务报告/客户服务报告.ts' }
		const entry = await studio.readFile({ projectId: project.id, path: target.entry })
		await studio.writeFile({
			projectId: project.id,
			...entry,
			expectedVersion: entry.version,
			content: entry.content.replace(
				'v.trim(), v.title',
				"v.trim(), v.transform((value) => value + '!'), v.title",
			),
		})
		const description = await studio.describeDocument(target)
		expect(description.editor?.regions.map((region) => region.id)).toEqual([
			'summary',
			'recommendations',
		])
		const initial: EditorDraft = {
			formatVersion: 1,
			templateId: description.editor!.templateId,
			templateRevision: description.editor!.templateRevision,
			regions: description.editor!.defaults,
		}
		await expect(studio.compile({ ...target, data: {}, clientRevision: 0 })).rejects.toMatchObject({
			code: 'EDITOR_DRAFT_REQUIRED',
		})
		expect(description.defaults.customer).toEqual({})
		const savedDefaults = await studio.setInput({
			...target,
			data: description.defaults,
			editor: initial,
			expectedVersion: null,
		})
		const defaultsCompiled = await studio.compile({
			...target,
			data: savedDefaults.data,
			editor: savedDefaults.editor,
			clientRevision: 0,
		})
		expect(defaultsCompiled.data.customer).toMatchObject({ name: '青山科技有限公司!' })
		expect(await studio.getInput(target)).toEqual(savedDefaults)
		expect(savedDefaults.data.customer).toEqual({})
		const raw = { customer: { name: ' Customer Alpha ' } }
		const saved = await studio.setInput({
			...target,
			data: raw,
			editor: initial,
			expectedVersion: savedDefaults.storageVersion,
		})
		expect(saved.data).toEqual(raw)
		expect(saved.storageVersion).toEqual(expect.any(String))
		await expect(
			studio.setInput({
				...target,
				data: { customer: { name: 'Concurrent caller' } },
				editor: initial,
				expectedVersion: null,
			}),
		).rejects.toMatchObject({ code: 'DRAFT_VERSION_CONFLICT' })
		const first = await studio.compile({
			...target,
			data: saved.data,
			editor: saved.editor,
			clientRevision: 1,
		})
		expect(first.data.customer).toMatchObject({ name: 'Customer Alpha!' })
		const firstPreview = await studio.getPreview(first)
		expect(firstPreview.clientRevision).toBe(1)
		expect(
			firstPreview.generatedMapping?.some(
				(mapping) => mapping.regionId === 'summary' && mapping.snapshotRevision === 1,
			),
		).toBe(true)
		expect(
			firstPreview.preview.navigation.points.some(
				(point) => point.path === '_editor/regions/summary.typ',
			),
		).toBe(true)
		expect(generatedSources[0]?.summary).toContain('/inputs/editor/data.json')
		expect(generatedSources[0]?.recommendations).toContain('#block(')
		const dataOnly = await studio.compile({
			...target,
			data: { customer: { name: ' Customer Beta ' } },
			editor: saved.editor,
			clientRevision: 2,
		})
		const nextPreview = await studio.getPreview(dataOnly)
		expect(nextPreview.preview.sessionId).toBe(firstPreview.preview.sessionId)
		expect(updates.at(-1)?.template).toBeUndefined()
		expect(updates.at(-1)?.files['/inputs/data.json']).toMatchObject({
			kind: 'json',
			value: { customer: { name: 'Customer Beta!' } },
		})
		expect(updates.at(-1)?.files['/inputs/editor/data.json']).toMatchObject({
			kind: 'text',
			text: expect.stringContaining('Customer Beta!'),
		})
		const changed = structuredClone(initial)
		changed.regions.recommendations!.content!.push({
			type: 'paragraph',
			content: [{ type: 'text', text: 'Unsaved follow-up — 𠮷 and a | literal.' }],
		})
		const edited = await studio.compile({
			...target,
			data: { customer: { name: ' Customer Beta ' } },
			editor: changed,
			clientRevision: 3,
		})
		expect(edited.pageCount).toBe(1)
		expect(edited.diagnostics).toEqual([])
		expect(updates.at(-1)?.template).toBeDefined()
		expect(await studio.getInput(target)).toEqual(saved)
		const editedPreview = await studio.getPreview(edited)
		expect(editedPreview.generatedMapping?.every((mapping) => mapping.snapshotRevision === 3)).toBe(
			true,
		)
		expect(editedPreview.preview.sessionId).toBe(firstPreview.preview.sessionId)
		const pdf = await studio.exportPdf(edited)
		const pdfBytes = await readFile(pdf.path)
		expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
		expect(pdf.revision).toBe(edited.revision)
		await expect(studio.exportPdf(first)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		const page = await studio.renderPage({ ...edited, page: 1, scale: 1 })
		await mkdir(resolve('test-results/typst-editor'), { recursive: true })
		await writeFile(
			resolve('test-results/typst-editor/studio-native.png'),
			await readFile(page.path),
		)
		await writeFile(
			resolve('test-results/typst-editor/studio-native.pdf'),
			await readFile(pdf.path),
		)
		await writeFile(
			resolve('test-results/typst-editor/studio-native.json'),
			JSON.stringify(
				{
					coldMs: defaultsCompiled.elapsedMs,
					dataOnlyMs: dataOnly.elapsedMs,
					regionEditMs: edited.elapsedMs,
					pageCount: edited.pageCount,
					mappings: editedPreview.generatedMapping?.length,
				},
				null,
				2,
			),
		)
		const bank = { projectId: project.id, entry: '报表/银行询证函/银行询证函.ts' }
		const bankDescription = await studio.describeDocument(bank)
		expect(bankDescription.editor).toBeUndefined()
		await studio.compile({ ...bank, data: {}, clientRevision: 0 })
		expect(materialize).toHaveBeenCalledTimes(1)
		for (const path of snapshots) expect(await readdir(path)).not.toContain('_editor')
		expect(await readdir(project.root)).not.toContain('_editor')
		for (const temporaryRoot of nativeRoots.filter((path) =>
			path.includes('pluxel-studio-editor-'),
		))
			await expect(
				readFile(join(temporaryRoot, '_editor/regions/summary.typ')),
			).rejects.toMatchObject({
				code: 'ENOENT',
			})
		const files = unzipSync(await studio.exportWorkspace({ projectId: project.id }))
		expect(
			Object.keys(files).some((path) => path.startsWith('_editor/') || path.startsWith('inputs/')),
		).toBe(false)
		expect(
			Buffer.from(
				Object.values(files).find((bytes) => Buffer.from(bytes).includes('Customer Beta!')) ?? [],
			).byteLength,
		).toBe(0)
		const forged = structuredClone(initial)
		forged.regions.recommendations!.content!.push({ type: 'table', content: [] })
		await expect(
			studio.setInput({
				...target,
				data: raw,
				editor: forged,
				expectedVersion: saved.storageVersion,
			}),
		).rejects.toMatchObject({ code: 'INVALID_EDITOR_DRAFT' })
		await expect(
			studio.compile({
				...target,
				data: raw,
				editor: { ...initial, templateRevision: 'forged' },
				clientRevision: 4,
			}),
		).rejects.toMatchObject({ code: 'TEMPLATE_REVISION_CONFLICT' })
		expect(await studio.getInput(target)).toEqual(saved)
		const module = await studio.readFile({ projectId: project.id, path: target.entry })
		const reserved = await studio.writeFile({
			projectId: project.id,
			...module,
			expectedVersion: module.version,
			content: module.content.replace(
				"template: './排版.typ',",
				"template: './排版.typ', createFiles(data) { return { '/inputs/editor/data.json': { kind: 'json', value: data } } },",
			),
		})
		const revisedDescription = await studio.describeDocument(target)
		const revised = revisedDescription.editor!
		await expect(
			studio.compile({
				...target,
				data: raw,
				editor: { ...initial, templateRevision: revised.templateRevision },
				clientRevision: 5,
			}),
		).rejects.toMatchObject({ code: 'EDITOR_RESOURCE_CONFLICT' })
		const retainedInput = await studio.getInput(target)
		expect(retainedInput.editor?.templateRevision).toBe(initial.templateRevision)
		await studio.writeFile({ projectId: project.id, ...module, expectedVersion: reserved.version })
		await studio.mkdir({ projectId: project.id, path: '_editor' })
		const occupiedDescription = await studio.describeDocument(target)
		const occupied = occupiedDescription.editor!
		await expect(
			studio.compile({
				...target,
				data: raw,
				editor: { ...initial, templateRevision: occupied.templateRevision },
				clientRevision: 6,
			}),
		).rejects.toMatchObject({ code: 'EDITOR_RESOURCE_CONFLICT' })
		const config = await studio.readFile({
			projectId: project.id,
			path: target.entry.replace('.ts', '.editor.json'),
		})
		await studio.writeFile({
			projectId: project.id,
			...config,
			expectedVersion: config.version,
			content: JSON.stringify({ ...JSON.parse(config.content), unknown: true }),
		})
		await expect(studio.describeDocument(target)).rejects.toMatchObject({
			code: 'INVALID_EDITOR_CONFIG',
		})
		expect(await studio.getInput(target)).toEqual(saved)
	} finally {
		materialize.mockRestore()
		initialize.mockRestore()
		update.mockRestore()
		await rm(root, { recursive: true, force: true })
	}
}, 120_000)

it('enforces the template table policy when admitting Studio drafts', () => {
	const content = {
		type: 'doc',
		content: [
			{
				type: 'table',
				content: [
					{
						type: 'tableRow',
						content: [
							{
								type: 'tableCell',
								content: [
									{
										type: 'paragraph',
										content: [{ type: 'text', text: 'Preserved body' }],
									},
								],
							},
						],
					},
				],
			},
		],
	}
	const config = {
		regions: [{ id: 'body' }],
		fields: [],
		defaults: { body: content },
		table: { defaultStyle: 'three-line', allowedStyles: [] },
	}
	const snapshot: WorkspaceSnapshot = {
		project: { id: 'test', name: 'Test', root: '/test' },
		revision: 'revision-1',
		config: { name: 'Test', fonts: [] },
		assets: [],
		files: { 'report.editor.json': JSON.stringify(config) },
	}
	const description = describeEditor(snapshot, 'report.ts')!
	expect(description.table).toEqual(config.table)
	const draft: EditorDraft = {
		formatVersion: 1,
		templateId: description.templateId,
		templateRevision: description.templateRevision,
		regions: description.defaults,
	}
	expect(validateEditorDraft(description, draft)).toEqual(draft)
	const forged = structuredClone(draft)
	forged.regions.body!.content![0]!.attrs = { tableStyle: 'borderless' }
	expect(() => validateEditorDraft(description, forged)).toThrowError(
		expect.objectContaining({ code: 'INVALID_EDITOR_DRAFT' }),
	)
	expect(draft.regions.body).toEqual(content)
	const openSides = describeEditor(
		{
			...snapshot,
			files: {
				'report.editor.json': JSON.stringify({
					...config,
					table: { defaultStyle: 'grid-open-sides', allowedStyles: ['grid-open-sides'] },
				}),
			},
		},
		'report.ts',
	)!
	forged.regions.body!.content![0]!.attrs = { tableStyle: 'grid-open-sides' }
	expect(validateEditorDraft(openSides, forged)).toEqual(forged)
	for (const table of [{ defaultStyle: 'none' }, { allowedStyles: ['none'] }, { unknown: true }]) {
		expect(() =>
			describeEditor(
				{
					...snapshot,
					files: {
						'report.editor.json': JSON.stringify({ ...config, table }),
					},
				},
				'report.ts',
			),
		).toThrowError(expect.objectContaining({ code: 'INVALID_EDITOR_CONFIG' }))
	}
})
