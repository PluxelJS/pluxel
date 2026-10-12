import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createTestHost } from '@pluxel/test'
import { FontsPlugin } from '@pluxel/fonts'
import { TypstPlugin } from '@pluxel/typst'
import { elysia } from '@pluxel/services/elysia'
import { nodeModules } from '@pluxel/services/node'
import { expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/backend/store.js'
import { InputStore } from '../src/backend/inputs.js'
import { StudioPlugin } from '../src/backend/plugin.js'
import type { CompileResult, WorkspaceTree, TextFile } from '../src/shared/contracts.js'

async function status(response: Promise<Response>) {
	const result = await response
	return result.status
}
async function body(response: Promise<Response>) {
	const result = await response
	return result.json()
}

it('serves filesystem workspaces, schema defaults and document-bound PDF through official plugins', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-test-'))
	const materialize = vi.spyOn(WorkspaceStore.prototype, 'materialize')
	try {
		await using host = await createTestHost({
			services: [elysia(), nodeModules()],
		})
		await host.commit((change) => {
			change.catalog.add([FontsPlugin, TypstPlugin, StudioPlugin])
			change.start(FontsPlugin, { initialConfig: { maxFontBytes: 32 * 1024 * 1024 } })
			change.start(StudioPlugin, {
				initialConfig: { root, assetsRoot: resolve('financial-document-assets') },
			})
		})
		const fetch = (path: string, init?: RequestInit) =>
			host.http.fetch(new URL(path, host.http.origin), init)
		const json = (method: string, value: unknown): RequestInit => ({
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(value),
		})
		const created = await fetch('/api/projects', json('POST', { name: 'Financial workspace' }))
		expect(created.status).toBe(200)
		const list = await body(fetch('/api/projects'))
		expect(list.length).toBeGreaterThan(0)
		const project = list[0]
		const path = `/api/projects/${project.id}`
		const tree: WorkspaceTree = await body(fetch(`${path}/tree`))
		expect(tree.documents.length).toBeGreaterThan(1)
		const searched = await body(
			fetch(`${path}/search?${new URLSearchParams({ q: '毛利率', mode: 'content' })}`),
		)
		expect(searched.matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: '报表/季度经营分析/排版.typ',
					line: expect.any(Number),
					text: expect.stringContaining('毛利率'),
				}),
			]),
		)
		const conversation = await body(fetch(`${path}/ai/threads`, { method: 'POST' }))
		const conversationPath = `${path}/ai/threads/${conversation.threadId}`
		expect(await body(fetch(conversationPath, json('PATCH', { title: '版式讨论' })))).toMatchObject(
			{ title: '版式讨论' },
		)
		expect(await body(fetch(conversationPath))).toMatchObject({ title: '版式讨论', messages: [] })
		const deletedConversation = await fetch(conversationPath, { method: 'DELETE' })
		expect(deletedConversation.status).toBe(200)
		const first = tree.documents.find((document) => document.name === '银行询证函')!
		const compile = (entry: string) => fetch(`${path}/compile`, json('POST', { entry }))
		const response = await compile(first.entry)
		const compiled: CompileResult = await response.json()
		if (!response.ok) throw new Error(JSON.stringify(compiled))
		expect(compiled.projectId).toBe(project.id)
		expect(compiled.entry).toBe(first.entry)
		expect(compiled.fields.length).toBeGreaterThan(0)
		expect(compiled.preview.data.length).toBeGreaterThan(100)
		const pdf = await fetch(
			`${path}/pdf?entry=${encodeURIComponent(first.entry)}&revision=${compiled.revision}`,
		)
		expect(
			Buffer.from(await pdf.arrayBuffer())
				.subarray(0, 5)
				.toString(),
		).toBe('%PDF-')
		expect(await status(fetch(`${path}/pdf?entry=other.typ&revision=${compiled.revision}`))).toBe(
			409,
		)
		const repeatedResponse = await compile(first.entry)
		const repeated: CompileResult = await repeatedResponse.json()
		expect(repeated.preview.sessionId).toBe(compiled.preview.sessionId)
		expect(repeated.preview.revision).toBeGreaterThan(compiled.preview.revision)
		const savedInput = await fetch(
			`${path}/input?entry=${encodeURIComponent(first.entry)}`,
			json('PUT', { data: { header: { companyName: 'External Studio input' } } }),
		)
		expect(savedInput.status).toBe(200)
		const storedInput = await body(fetch(`${path}/input?entry=${encodeURIComponent(first.entry)}`))
		expect(storedInput.data.header.companyName).toBe('External Studio input')
		const inputResponse = await compile(first.entry)
		const withInput: CompileResult = await inputResponse.json()
		expect(withInput.preview.sessionId).toBe(compiled.preview.sessionId)
		expect(withInput.revision).not.toBe(compiled.revision)
		expect(withInput.data.header).toMatchObject({ companyName: 'External Studio input' })
		expect(tree.entries.some((file) => file.path.endsWith('/data.json'))).toBe(false)
		const explicitResponse = await fetch(
			`${path}/compile`,
			json('POST', { entry: first.entry, data: { header: { companyName: 'One-time request' } } }),
		)
		const explicit = await explicitResponse.json()
		expect(explicit.data.header.companyName).toBe('One-time request')
		const unchangedInput = await body(
			fetch(`${path}/input?entry=${encodeURIComponent(first.entry)}`),
		)
		expect(unchangedInput.data).toEqual(storedInput.data)
		expect(materialize).toHaveBeenCalledTimes(1)
		expect(await new InputStore(join(root, 'inputs')).get(project.id, first.entry)).toEqual(
			storedInput.data,
		)
		compiled.revision = explicit.revision
		const second = tree.documents.find((document) => document.name === '银行账户余额汇总表')!
		const secondResponse = await compile(second.entry)
		expect(secondResponse.status).toBe(200)
		const analysisEntry = '报表/季度经营分析/季度经营分析.ts'
		const analysisResponse = await compile(analysisEntry)
		const analysis: CompileResult = await analysisResponse.json()
		if (!analysisResponse.ok) throw new Error(JSON.stringify(analysis))
		expect(analysis.preview.data.length).toBeGreaterThan(100)
		expect(analysis.data.projects).toHaveLength(36)
		const analysisPdf = await fetch(
			`${path}/pdf?entry=${encodeURIComponent(analysisEntry)}&revision=${analysis.revision}`,
		)
		expect(analysisPdf.status).toBe(200)
		const analysisBytes = Buffer.from(await analysisPdf.arrayBuffer())
		expect(analysisBytes.subarray(0, 5).toString()).toBe('%PDF-')
		expect(
			(analysisBytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length,
		).toBeGreaterThan(1)
		expect(analysis.diagnostics).toEqual([])
		const studio = host.require(StudioPlugin)
		const pages = analysis.preview.navigation.pages
		expect(pages.length).toBeGreaterThan(1)
		const pageImages = await studio.readPreviewPages(project.id, {
			entry: analysisEntry,
			revision: analysis.revision,
			pages: [1, pages.length],
		})
		expect(pageImages.map((image) => image.page)).toEqual([1, pages.length])
		for (const image of pageImages) {
			const bytes = Buffer.from(image.data)
			expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
			expect(bytes.readUInt32BE(16)).toBe(image.width)
			expect(bytes.readUInt32BE(20)).toBe(image.height)
			expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1601)
			expect(image.revision).toBe(analysis.preview.revision)
			expect(image.sources).toEqual(
				expect.arrayContaining([expect.objectContaining({ path: '报表/季度经营分析/排版.typ' })]),
			)
		}
		const cropped = await studio.readPreviewPages(project.id, {
			entry: analysisEntry,
			revision: analysis.revision,
			pages: [1],
			region: { x: 50, y: 50, width: 200, height: 150 },
		})
		expect(cropped[0]?.width).toBeLessThan(pageImages[0]!.width)
		expect(cropped[0]?.region.x).toBeCloseTo(50)
		await expect(
			studio.readPreviewPages(project.id, {
				entry: analysisEntry,
				revision: 'stale',
				pages: [1],
			}),
		).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		await fetch(
			`${path}/input?entry=${encodeURIComponent(analysisEntry)}`,
			json('PUT', { data: { revenue: 1400000 } }),
		)
		await expect(
			studio.readPreviewPages(project.id, {
				entry: analysisEntry,
				revision: analysis.revision,
				pages: [1],
			}),
		).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		const updatedAnalysis = (await body(compile(analysisEntry))) as CompileResult
		const analysisSource: TextFile = await body(
			fetch(`${path}/file?path=${encodeURIComponent('报表/季度经营分析/排版.typ')}`),
		)
		await fetch(
			`${path}/file`,
			json('PUT', {
				path: analysisSource.path,
				expectedVersion: analysisSource.version,
				content: analysisSource.content + '\n// External layout edit\n',
			}),
		)
		await expect(
			studio.readPreviewPages(project.id, {
				entry: analysisEntry,
				revision: updatedAnalysis.revision,
				pages: [1],
			}),
		).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		const read = async (file: string): Promise<TextFile> =>
			await body(fetch(`${path}/file?path=${encodeURIComponent(file)}`))
		const schema = await read(first.entry)
		const changed = await fetch(
			`${path}/file`,
			json('PUT', {
				path: schema.path,
				expectedVersion: schema.version,
				content: schema.content.replace(
					'schema: v.object({',
					'schema: v.object({ required: v.string(),',
				),
			}),
		)
		expect(changed.status).toBe(200)
		const invalid = await compile(first.entry)
		const failure = await invalid.json()
		expect(invalid.status).toBe(400)
		expect(failure.fields).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'required' })]),
		)
		expect(failure.data).toBeDefined()
		expect(
			await status(
				fetch(`${path}/pdf?entry=${encodeURIComponent(first.entry)}&revision=${compiled.revision}`),
			),
		).toBe(200)
		expect(
			await status(
				fetch(
					`${path}/file`,
					json('PUT', {
						path: schema.path,
						expectedVersion: schema.version,
						content: schema.content,
					}),
				),
			),
		).toBe(409)
		expect(await status(fetch(`${path}/report`, json('POST', { path: 'plain' })))).toBe(200)
		const plain = await compile('plain/plain.ts')
		expect(plain.status).toBe(200)
		const plainResult = await plain.json()
		expect(plainResult.fields).toHaveLength(2)
		const originalPlain = await read('plain/排版.typ')
		const brokenWrite = await fetch(
			`${path}/file`,
			json('PUT', {
				path: originalPlain.path,
				expectedVersion: originalPlain.version,
				content: '#let broken = (',
			}),
		)
		expect(brokenWrite.status).toBe(200)
		const brokenCompile = await compile('plain/plain.ts')
		expect(brokenCompile.status).toBe(400)
		const brokenResult = await brokenCompile.json()
		expect(brokenResult.code).toBe('COMPILE_FAILED')
		const brokenPlain = await read('plain/排版.typ')
		const repairedWrite = await fetch(
			`${path}/file`,
			json('PUT', {
				path: originalPlain.path,
				expectedVersion: brokenPlain.version,
				content: originalPlain.content,
			}),
		)
		expect(repairedWrite.status).toBe(200)
		const repairedCompile = await compile('plain/plain.ts')
		expect(repairedCompile.status).toBe(200)
		const repaired = await repairedCompile.json()
		expect(repaired.revision).toBe(plainResult.revision)
		expect(repaired.preview.sessionId).toBe(plainResult.preview.sessionId)
		expect(repaired.preview.revision).toBeGreaterThan(plainResult.preview.revision)
		const configFile = await read('studio.json')
		const configWithoutFonts = JSON.parse(configFile.content)
		configWithoutFonts.fonts = []
		await fetch(
			`${path}/file`,
			json('PUT', {
				path: 'studio.json',
				expectedVersion: configFile.version,
				content: JSON.stringify(configWithoutFonts),
			}),
		)
		const noFontsResponse = await compile('plain/plain.ts')
		const noFonts = await noFontsResponse.json()
		expect(noFonts.preview.sessionId).not.toBe(plainResult.preview.sessionId)
		for (let index = 0; index < 4; index++) {
			const folder = `extra-${index}`
			const entry = `${folder}/${folder}.ts`
			await fetch(`${path}/report`, json('POST', { path: folder }))
			const result = await compile(entry)
			expect(result.status).toBe(200)
		}
		const reopenedResponse = await compile('plain/plain.ts')
		const reopened = await reopenedResponse.json()
		expect(reopened.preview.sessionId).not.toBe(noFonts.preview.sessionId)
		const exported = await fetch(`${path}/export`)
		expect(exported.headers.get('content-type')).toContain('application/zip')
		const imported = await fetch('/api/import', {
			method: 'POST',
			body: await exported.arrayBuffer(),
		})
		expect(imported.status).toBe(200)
		const copy = await imported.json()
		expect(copy.id).not.toBe(project.id)
		expect(await status(fetch(`${path}/file?path=../outside.txt`))).toBe(400)
		const compiling = compile('plain/plain.ts')
		const forgetting = fetch(path, { method: 'DELETE' })
		const [compiledDuringForget, forgotten] = await Promise.all([compiling, forgetting])
		// HTTP body parsing may admit either request first; both legal orders must settle.
		expect([200, 404]).toContain(compiledDuringForget.status)
		expect(forgotten.status).toBe(200)
		expect(await status(compile('plain/plain.ts'))).toBe(404)
		expect(await readFile(join(project.root, 'plain/排版.typ'), 'utf8')).toBe(originalPlain.content)
		expect(await status(fetch(path))).toBe(404)
	} finally {
		materialize.mockRestore()
		await rm(root, { recursive: true, force: true })
	}
})
