import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { createTestHost } from '@pluxel/test'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { nodeModules } from '@pluxel/services/node'
import { expect, it, vi } from 'vitest'
import { NativeCompilerClient } from '../../../plugins/render/typst/src/native-client.ts'
import { WorkspaceStore } from '../src/backend/store.js'
import { StudioPlugin } from '../src/backend/plugin.js'
import { createWorkspaceTools } from '../src/backend/ai-tools.js'
import { inputData } from '../src/backend/inputs.js'

it('preserves all workspace/document behaviors through the shared service and real native worker', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-test-'))
	const materialize = vi.spyOn(WorkspaceStore.prototype, 'materialize')
	const originalRun = NativeCompilerClient.prototype.run
	const clients = new Set<NativeCompilerClient>(),
		workers = new Set<object>()
	const native = vi.spyOn(NativeCompilerClient.prototype, 'run').mockImplementation(async function (
		this: NativeCompilerClient,
		input,
		signal,
	) {
		clients.add(this)
		const result = await originalRun.call(this, input, signal)
		workers.add(Reflect.get(this, 'worker'))
		return result
	})
	try {
		await using host = await createTestHost({ services: [nodeModules()] })
		await host.commit((change) => {
			change.catalog.add([FontsPlugin, TypstPlugin, StudioPlugin])
			change.start(FontsPlugin, { initialConfig: { maxFontBytes: 32 * 1024 * 1024 } })
			change.start(TypstPlugin, {
				initialConfig: {
					maxTemplateBytes: 128 * 1024 * 1024,
					maxFontBytes: 96 * 1024 * 1024,
					maxSessions: 4,
					maxQueuedUpdates: 8,
				},
			})
			change.start(StudioPlugin, {
				initialConfig: { root, assetsRoot: resolve('financial-document-assets') },
			})
		})
		const studio = host.require(StudioPlugin)
		const project = await studio.createProject({ name: 'Financial workspace' })
		expect(await studio.listProjects()).toEqual(expect.arrayContaining([project]))
		const tree = await studio.getTree({ projectId: project.id })
		expect(tree.documents).toHaveLength(3)
		const search = await studio.search({ projectId: project.id, query: '毛利率', mode: 'content' })
		expect(search.matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: '报表/季度经营分析/排版.typ', line: expect.any(Number) }),
			]),
		)
		const conversation = await studio.createThread({ projectId: project.id })
		await studio.renameThread({
			projectId: project.id,
			threadId: conversation.threadId,
			title: '版式讨论',
		})
		expect(
			await studio.snapshot({ projectId: project.id, threadId: conversation.threadId }),
		).toMatchObject({ title: '版式讨论', messages: [] })
		await studio.deleteThread({ projectId: project.id, threadId: conversation.threadId })
		const entry = tree.documents.find((document) => document.name === '银行询证函')!.entry
		const target = { projectId: project.id, entry }
		const description = await studio.describeDocument(target)
		expect(description.fields.length).toBeGreaterThan(0)
		const first = await studio.compile({ ...target, data: {} })
		expect(first).not.toHaveProperty('fields')
		expect(first).not.toHaveProperty('preview')
		const vector = await studio.getPreview({ ...target, revision: first.revision })
		expect(vector.preview.data).toBeInstanceOf(Uint8Array)
		expect(vector.preview.data.byteLength).toBeGreaterThan(100)
		expect(first.sourceRevision).toBe(tree.revision)
		await studio.setInput({ ...target, data: { header: { companyName: 'Saved input' } } })
		const next = await studio.compile({
			...target,
			data: { header: { companyName: 'Explicit input' } },
		})
		expect(next.data.header).toMatchObject({ companyName: 'Explicit input' })
		const savedInput = await studio.getInput(target)
		expect(savedInput.data).toEqual({ header: { companyName: 'Saved input' } })
		expect(next.revision).not.toBe(first.revision)
		const nextVector = await studio.getPreview({ ...target, revision: next.revision })
		expect(nextVector.preview.sessionId).toBe(vector.preview.sessionId)
		expect(materialize).toHaveBeenCalledTimes(1)
		// Direct external file edits must preserve the same worker for both Typst and TS/shared HMR.
		const layoutPath = '报表/银行询证函/排版.typ'
		const layout = await studio.readFile({ projectId: project.id, path: layoutPath })
		await writeFile(join(project.root, layoutPath), layout.content + '\n// External layout edit\n')
		const typstUpdated = await studio.compile({ ...target, data: {} })
		const module = await studio.readFile({ projectId: project.id, path: entry })
		await writeFile(join(project.root, entry), module.content + '\n// External TS edit\n')
		const tsUpdated = await studio.compile({ ...target, data: {} })
		const themePath = '共享/主题/财务函件.typ'
		const theme = await studio.readFile({ projectId: project.id, path: themePath })
		await writeFile(join(project.root, themePath), theme.content + '\n// Shared import edit\n')
		const sharedUpdated = await studio.compile({ ...target, data: {} })
		const latestVector = await studio.getPreview({ ...target, revision: sharedUpdated.revision })
		expect(latestVector.preview.sessionId).toBe(vector.preview.sessionId)
		expect(clients.size).toBe(1)
		expect(workers.size).toBe(1)
		await mkdir(resolve('test-results/refactor'), { recursive: true })
		await writeFile(
			resolve('test-results/refactor/native-reuse.json'),
			JSON.stringify(
				{
					evidence: 'native-reuse',
					nativeClients: clients.size,
					workers: workers.size,
					sessionId: vector.preview.sessionId,
					compileRevisions: [
						first.revision,
						next.revision,
						typstUpdated.revision,
						tsUpdated.revision,
						sharedUpdated.revision,
					],
					coldMs: first.elapsedMs,
					hotMs: next.elapsedMs,
					vectorBytes: latestVector.preview.data.byteLength,
				},
				null,
				2,
			),
		)
		const pdf = await studio.exportPdf({ ...target, revision: sharedUpdated.revision })
		const pdfBytes = await readFile(pdf.path)
		expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
		await studio.setInput({ ...target, data: { header: { companyName: 'Changed stored input' } } })
		const savedIndependent = await studio.renderPage({
			...target,
			revision: sharedUpdated.revision,
			page: 1,
			scale: 1,
		})
		const independentBytes = await readFile(savedIndependent.path)
		expect(independentBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
		await expect(studio.getPreview({ ...target, revision: first.revision })).rejects.toMatchObject({
			code: 'REVISION_CONFLICT',
		})
		const analysis = { projectId: project.id, entry: '报表/季度经营分析/季度经营分析.ts' }
		const compiled = await studio.compile({ ...analysis, data: {} })
		expect(compiled.data.projects).toHaveLength(36)
		expect(compiled.pageCount).toBeGreaterThan(2)
		expect(compiled.outline).toEqual(
			expect.arrayContaining([expect.objectContaining({ title: '经营概况' })]),
		)
		const pageArtifacts = []
		for (const page of [1, 2, compiled.pageCount])
			pageArtifacts.push(
				await studio.renderPage({ ...analysis, revision: compiled.revision, page, scale: 1 }),
			)
		const crop = await studio.renderPage({
			...analysis,
			revision: compiled.revision,
			page: 1,
			scale: 2,
			region: { x: 50, y: 50, width: 200, height: 150 },
		})
		expect(crop.width).toBe(400)
		expect(crop.height).toBe(300)
		await expect(
			studio.renderPage({ ...analysis, revision: compiled.revision, page: 0 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		await expect(
			studio.renderPage({
				...analysis,
				revision: compiled.revision,
				page: 1,
				region: { x: 0, y: 0, width: 10000, height: 10 },
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		const options = {
			root: join(root, 'ai'),
			getProject: (id: string) => studio.getProject({ projectId: id }),
			tree: (id: string) => studio.getTree({ projectId: id }),
			readFile: (id: string, path: string) => studio.readFile({ projectId: id, path }),
			writeFile: (id: string, input: Parameters<WorkspaceStore['writeFile']>[1]) =>
				studio.writeFile({ projectId: id, ...input }),
			mkdir: (id: string, path: string) => studio.mkdir({ projectId: id, path }),
			rename: (id: string, input: Parameters<WorkspaceStore['rename']>[1]) =>
				studio.rename({ projectId: id, ...input }),
			remove: (id: string, input: Parameters<WorkspaceStore['remove']>[1]) =>
				studio.remove({ projectId: id, ...input }),
			compile: studio.compile.bind(studio),
			getInput: studio.getInput.bind(studio),
			getPreview: studio.getPreview.bind(studio),
			renderPage: studio.renderPage.bind(studio),
			exportPdf: studio.exportPdf.bind(studio),
			readArtifact: async (id: string) => {
				const artifact = await studio.resolveArtifact({ id })
				return readFile(artifact.path)
			},
		}
		const tools = createWorkspaceTools(options, project, () => {}, true)
		const imageTool = tools.find((tool) => tool.name === 'read_preview_pages')!
		const images = await imageTool.execute(
			'real-image',
			{ entry: analysis.entry, revision: compiled.revision, pages: [1, 2, compiled.pageCount] },
			undefined,
			undefined,
			undefined as never,
		)
		await writeFile(
			resolve('test-results/refactor/pi-image-content.json'),
			JSON.stringify(
				{
					imageBlocks: images.content.filter((block) => block.type === 'image').length,
					artifacts: images.details,
					contentHashes: images.content
						.filter((block) => block.type === 'image')
						.map((block) =>
							block.type === 'image'
								? {
										mimeType: block.mimeType,
										byteLength: Buffer.from(block.data, 'base64').byteLength,
										sha256: createHash('sha256')
											.update(Buffer.from(block.data, 'base64'))
											.digest('hex'),
									}
								: null,
						),
				},
				null,
				2,
			),
		)
		const imageBlocks = images.content.filter((block) => block.type === 'image')
		expect(imageBlocks).toHaveLength(3)
		const details = images.details as { pages: { id: string }[] }
		for (const [index, block] of imageBlocks.entries()) {
			const imageBytes = Buffer.from(block.data, 'base64')
			expect(imageBytes).toEqual(await options.readArtifact(details.pages[index]!.id))
			await writeFile(resolve(`test-results/refactor/pi-page-${index + 1}.png`), imageBytes)
		}
		const noVision = createWorkspaceTools(options, project, () => {}, false).find(
			(tool) => tool.name === 'read_preview_pages',
		)!
		await expect(
			noVision.execute(
				'denied',
				{ entry: analysis.entry, revision: compiled.revision, pages: [1] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow('未启用图片输入')
		const readTool = tools.find((tool) => tool.name === 'read')!
		await expect(
			readTool.execute(
				'denied',
				{ path: pageArtifacts[0]!.path },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow('outside')
		const pdfTool = tools.find((tool) => tool.name === 'export_pdf')!
		expect(
			JSON.stringify(
				await pdfTool.execute(
					'pdf',
					{ entry: analysis.entry, revision: compiled.revision },
					undefined,
					undefined,
					undefined as never,
				),
			),
		).toContain('application/pdf')
		// Explicit input does not mutate persistence; invalid entry/schema remains editable.
		await expect(studio.compile({ ...target } as never)).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		})
		const currentModule = await studio.readFile({ projectId: project.id, path: entry })
		await studio.writeFile({
			projectId: project.id,
			...module,
			expectedVersion: currentModule.version,
			content: module.content.replace(
				'schema: v.object({',
				'schema: v.object({ required: v.string(),',
			),
		})
		await expect(studio.compile({ ...target, data: {} })).rejects.toMatchObject({
			code: 'INVALID_INPUT',
			issues: expect.arrayContaining([expect.objectContaining({ path: ['required'] })]),
		})
		const invalidDescription = await studio.describeDocument(target)
		expect(invalidDescription.fields).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'required' })]),
		)
		await expect(
			studio.writeFile({ projectId: project.id, ...module, expectedVersion: module.version }),
		).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		await studio.createReport({ projectId: project.id, path: 'plain' })
		const plain = { projectId: project.id, entry: 'plain/plain.ts' }
		const clean = await studio.compile({ ...plain, data: {} })
		const cleanVector = await studio.getPreview({ ...plain, revision: clean.revision })
		const original = await studio.readFile({ projectId: project.id, path: 'plain/排版.typ' })
		const broken = await studio.writeFile({
			projectId: project.id,
			...original,
			expectedVersion: original.version,
			content: '#let broken = (',
		})
		await expect(studio.compile({ ...plain, data: {} })).rejects.toMatchObject({
			code: 'COMPILE_FAILED',
			diagnostics: expect.arrayContaining([expect.objectContaining({ path: 'plain/排版.typ' })]),
		})
		await studio.writeFile({ projectId: project.id, ...original, expectedVersion: broken.version })
		const repaired = await studio.compile({ ...plain, data: {} })
		expect(repaired.revision).not.toBe(clean.revision)
		const repairedPreview = await studio.getPreview({ ...plain, revision: repaired.revision })
		expect(repairedPreview.preview.sessionId).toBe(cleanVector.preview.sessionId)
		const config = await studio.readFile({ projectId: project.id, path: 'studio.json' })
		await studio.writeFile({
			projectId: project.id,
			...config,
			expectedVersion: config.version,
			content: JSON.stringify({ ...JSON.parse(config.content), fonts: [] }),
		})
		const noFonts = await studio.compile({ ...plain, data: {} })
		const noFontsVector = await studio.getPreview({ ...plain, revision: noFonts.revision })
		expect(noFontsVector.preview.sessionId).not.toBe(cleanVector.preview.sessionId)
		for (let index = 0; index < 4; index++) {
			const folder = `extra-${index}`
			await studio.createReport({ projectId: project.id, path: folder })
			await studio.compile({ projectId: project.id, entry: `${folder}/${folder}.ts`, data: {} })
		}
		const reopened = await studio.compile({ ...plain, data: {} })
		const reopenedPreview = await studio.getPreview({ ...plain, revision: reopened.revision })
		expect(reopenedPreview.preview.sessionId).not.toBe(noFontsVector.preview.sessionId)
		const zip = await studio.exportWorkspace({ projectId: project.id })
		expect(Buffer.from(zip).subarray(0, 4).toString('hex')).toBe('504b0304')
		const copy = await studio.importWorkspace({ bytes: zip })
		expect(copy.id).not.toBe(project.id)
		await expect(
			studio.readFile({ projectId: project.id, path: '../outside.txt' }),
		).rejects.toThrow('Invalid workspace path')
		const compiling = studio.compile({ ...plain, data: {} }),
			forgetting = studio.forgetProject({ projectId: project.id })
		await Promise.allSettled([compiling, forgetting])
		await forgetting
		await expect(studio.getProject({ projectId: project.id })).rejects.toThrow('Unknown workspace')
		expect(await readFile(join(project.root, 'plain/排版.typ'), 'utf8')).toBe(original.content)
		const retainedPdf = await readFile(pdf.path)
		expect(retainedPdf.subarray(0, 5).toString()).toBe('%PDF-')
		for (const artifact of pageArtifacts) {
			const bytes = await readFile(artifact.path)
			expect(bytes.byteLength).toBe(artifact.byteLength)
		}
	} finally {
		materialize.mockRestore()
		native.mockRestore()
		await rm(root, { recursive: true, force: true })
	}
}, 120_000)

it('strict JSON validation preserves explicit values and rejects lossy encodings', () => {
	expect(inputData({ empty: '', zero: 0, no: false, null: null, array: [] })).toEqual({
		empty: '',
		zero: 0,
		no: false,
		null: null,
		array: [],
	})
	const cycle: Record<string, unknown> = {}
	cycle.self = cycle
	for (const value of [
		{ n: NaN },
		{ n: Infinity },
		{ u: undefined },
		{ b: 1n },
		{ d: new Date() },
		{ a: Array(2) },
		cycle,
	])
		expect(() => inputData(value)).toThrow(/JSON/)
})
