import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RpcStub, RpcTarget } from 'capnweb'
import { expect, it } from 'vitest'
import { createTestHost } from '@pluxel/test'
import { nodeModules } from '@pluxel/services/node'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { StudioPlugin } from '../src/backend/plugin.js'
import type { BodyEditorParticipant, DocumentInput } from '../src/shared/contracts.js'

it('edits the same body headlessly and through an unsaved participant with revision rejection and honest post-commit failure', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-body-tools-'))
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
		const project = await studio.createProject({ name: 'Body tools' })
		const target = { projectId: project.id, entry: '报表/客户服务报告/客户服务报告.ts' }
		const description = await studio.describeDocument(target)
		const original = await studio.readBody(target)
		expect(original.regions.map((region) => region.regionId)).toEqual([
			'summary',
			'recommendations',
		])
		const initialInput = await studio.getInput(target)
		expect(initialInput.storageVersion).toBeNull()
		const summary = original.regions[0]!
		const candidate = {
			...target,
			regionId: 'summary',
			baseRevision: original.baseRevision,
			markdown: summary.markdown.replace(
				'本期服务已完成交付，详细情况如下。',
				'[textStyle {"color":"#16a34a","backgroundColor":"#e0f2fe"}]Agent revised delivery.[/textStyle]',
			),
		}
		expect(candidate.markdown).not.toBe(summary.markdown)
		const committed = await studio.applyBodyCandidate(candidate)
		expect(committed.editorStatus).toBe('headless')
		expect(committed.previewError).toBeUndefined()
		expect(committed.compile?.pageCount).toBeGreaterThan(0)
		expect(committed.input.editor!.regions.recommendations).toEqual(
			description.editor!.defaults.recommendations,
		)
		expect(JSON.stringify(committed.input.editor!.regions.summary)).toContain('#16a34a')
		const png = await studio.renderPage({
			...target,
			revision: committed.compile!.revision,
			page: 1,
		})
		const pngBytes = await readFile(png.path)
		expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		await expect(studio.applyBodyCandidate(candidate)).rejects.toMatchObject({
			code: 'STALE_CANDIDATE',
		})
		const fresh = await studio.readBody({ ...target, regionId: 'summary' })
		await expect(
			studio.applyBodyCandidate({
				...candidate,
				baseRevision: fresh.baseRevision,
				markdown: '[textStyle {"color":"invalid"}]Invalid[/textStyle]',
			}),
		).rejects.toMatchObject({ code: 'INVALID_EDITOR_DRAFT' })
		expect(await studio.getInput(target)).toEqual(committed.input)
		let unsaved: DocumentInput = structuredClone(committed.input)
		unsaved.editor!.regions.recommendations = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Unsaved human recommendation' }] },
			],
		}
		class Participant extends RpcTarget implements BodyEditorParticipant {
			async capture() {
				return { lease: 'lease', input: structuredClone(unsaved), clientRevision: 41 }
			}
			async finish(input: Parameters<BodyEditorParticipant['finish']>[0]) {
				if (input.commit) throw new Error('Editor disconnected after persistence')
			}
		}
		using participant = new RpcStub(new Participant())
		const attachment = await studio.attachBodyEditor({ projectId: project.id }, participant)
		try {
			const captured = await studio.readBody({ ...target, regionId: 'recommendations' })
			expect(captured.regions[0]!.markdown).toContain('Unsaved human recommendation')
			expect(await studio.getInput(target)).toEqual(committed.input)
			unsaved = { ...unsaved, data: { ...unsaved.data, customer: { name: 'Later human input' } } }
			await expect(
				studio.applyBodyCandidate({
					...target,
					regionId: 'recommendations',
					baseRevision: captured.baseRevision,
					markdown: 'Would overwrite',
				}),
			).rejects.toMatchObject({ code: 'STALE_CANDIDATE' })
			const latest = await studio.readBody({ ...target, regionId: 'recommendations' })
			const receipt = await studio.applyBodyCandidate({
				...target,
				regionId: 'recommendations',
				baseRevision: latest.baseRevision,
				markdown: latest.regions[0]!.markdown.replace(
					'recommendation',
					'recommendation improved by agent',
				),
			})
			expect(receipt.editorStatus).toBe('disconnected')
			expect(receipt.editorError).toContain('Editor disconnected')
			expect(receipt.compile?.clientRevision).toBe(42)
			expect(await studio.getInput(target)).toEqual(receipt.input)
			expect(receipt.input.data.customer).toEqual({ name: 'Later human input' })
			expect(receipt.input.editor!.regions.summary).toEqual(committed.input.editor!.regions.summary)
		} finally {
			await attachment.close()
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 120_000)
