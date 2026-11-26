import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { nodeModules } from '@pluxel/services/node'
import { createTestHost } from '@pluxel/test'
import { expect, it } from 'vitest'
import { TypstPlugin } from '../src/index.ts'
import { createDocumentService } from './consumer/document-private/server'
import type { DocumentSource, DocumentView } from './consumer/document-contract'

it('retains real Typst files across leases and rejects a stale concurrent save', async () => {
	await using host = await createTestHost({ services: [nodeModules()] })
	await host.start(FontsPlugin.nodeAddress())
	const typst = await host.start(TypstPlugin.nodeAddress())
	const directory = await mkdtemp(join(tmpdir(), 'typst-chapter-store-'))
	const options = {
		typst,
		directory,
		canOpen: () => true,
		onError(error: unknown) {
			throw error
		},
	}
	const documentId = randomUUID()
	const author = randomUUID()
	const competitor = randomUUID()
	const emitted = join(directory, documentId, 'saved.json')
	let service = createDocumentService(options)
	try {
		const [first, second] = (await Promise.all([
			service.execute(author, { action: 'open', documentId }),
			service.execute(competitor, { action: 'open', documentId }),
		])) as [DocumentView, DocumentView]
		expect(first.preview?.revision).toBe(first.revision)
		expect(second.preview?.revision).toBe(second.revision)

		const chapterId = 'background'
		const initial = (await service.execute(author, {
			action: 'source',
			chapterId,
			baseRevision: first.revision,
		})) as DocumentSource
		expect(initial.source).not.toContain('DOCUMENT_PRIVATE_SOURCE_')
		await expect(
			service.execute(author, {
				action: 'edit',
				chapterId,
				baseRevision: first.revision,
				content: { kind: 'typst', source: '#let number = 1' },
			}),
		).rejects.toMatchObject({
			code: 'UNSUPPORTED_SYNTAX',
			issues: [expect.objectContaining({ from: expect.any(Number), to: expect.any(Number) })],
		})
		expect(
			await service.execute(author, { action: 'source', chapterId, baseRevision: first.revision }),
		).toEqual(initial)

		const authorEdit = (await service.execute(author, {
			action: 'edit',
			chapterId,
			baseRevision: first.revision,
			content: { kind: 'typst', source: '#strong[保存后的原生正文。]' },
		})) as DocumentView
		const competitorEdit = (await service.execute(competitor, {
			action: 'edit',
			chapterId,
			baseRevision: second.revision,
			content: {
				kind: 'tiptap',
				document: {
					type: 'doc',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: '待解决的版本。' }] }],
				},
			},
		})) as DocumentView
		await expect(
			service.execute(author, { action: 'save', baseRevision: authorEdit.revision }),
		).resolves.toMatchObject({ dirty: false })
		const version: unknown = JSON.parse(await readFile(emitted, 'utf8'))
		expect(typeof version).toBe('string')
		const path = join(directory, documentId, String(version), 'chapters', 'background.typ')
		const diskSource = await readFile(path, 'utf8')
		expect(diskSource).toContain('保存后的原生正文。')

		await expect(
			service.execute(competitor, { action: 'save', baseRevision: competitorEdit.revision }),
		).rejects.toMatchObject({ code: 'CONFLICT' })
		expect(await readFile(path, 'utf8')).toBe(diskSource)
		expect(JSON.parse(await readFile(emitted, 'utf8'))).toBe(version)

		await service.close()
		service = createDocumentService(options)
		const reopened = (await service.execute(author, { action: 'open', documentId })) as DocumentView
		expect(reopened.dirty).toBe(false)
		expect(
			await service.execute(author, {
				action: 'source',
				chapterId,
				baseRevision: reopened.revision,
			}),
		).toEqual({ revision: reopened.revision, source: diskSource })
		const pdf = await service.execute(author, { action: 'pdf', revision: reopened.revision })
		expect(
			Buffer.from(pdf as Uint8Array)
				.subarray(0, 5)
				.toString(),
		).toBe('%PDF-')

		const legacyId = randomUUID()
		const legacyMarker = join(directory, legacyId, 'saved.json')
		const legacyData = JSON.stringify({ 'private-proposal/chapters/background.typ': '原来的正文' })
		await mkdir(join(directory, legacyId))
		await writeFile(legacyMarker, legacyData)
		await expect(
			service.execute(randomUUID(), { action: 'open', documentId: legacyId }),
		).rejects.toMatchObject({ code: 'MIGRATION_REQUIRED' })
		expect(await readFile(legacyMarker, 'utf8')).toBe(legacyData)
	} finally {
		try {
			await service.close()
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}
}, 30_000)
