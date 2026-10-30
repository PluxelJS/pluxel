import { readFile } from 'node:fs/promises'
import { RpcStub, RpcTarget } from 'capnweb'
import { expect, it } from 'vitest'
import { studioFixture } from './studio-fixture.js'
import type { BodyEditorParticipant, DocumentInput } from '../src/shared/contracts.js'
it('shares native sources between headless edits and captured unsaved edits, with honest commit failure receipts', async () => {
	await using fixture = await studioFixture('Source body tools')
	const { studio, project } = fixture,
		target = { projectId: project.id, entry: '报表/客户服务报告/客户服务报告.ts' }
	const original = await studio.readBody(target),
		initial = await studio.getInput(target)
	expect(original.files.map((file) => file.path)).toEqual([
		'报表/客户服务报告/summary.typ',
		'报表/客户服务报告/recommendations.typ',
	])
	expect(initial.storageVersion).not.toBeNull()
	const summary = original.files[0]!,
		candidate = {
			...target,
			path: summary.path,
			baseRevision: original.baseRevision,
			source: summary.source.replace(
				'本期服务已完成交付，详细情况如下。',
				'#text(fill: rgb("#16a34a"))[Agent revised delivery.]',
			),
		}
	const committed = await studio.applyBodyCandidate(candidate)
	expect(committed.editorStatus).toBe('headless')
	expect(committed.previewError).toBeUndefined()
	expect(committed.compile!.pageCount).toBeGreaterThan(0)
	expect(committed.input.editor!.files[original.files[1]!.path]).toBe(original.files[1]!.source)
	const rendered = await studio.renderPage({ ...committed.compile!, page: 1 })
	expect(await readFile(rendered.path)).toEqual(expect.any(Buffer))
	await expect(studio.applyBodyCandidate(candidate)).rejects.toMatchObject({
		code: 'STALE_CANDIDATE',
	})
	const afterCommit = await studio.readBody(target)
	expect(afterCommit.baseRevision).toBe(committed.baseRevision)
	const chained = await studio.applyBodyCandidate({
		...target,
		path: summary.path,
		baseRevision: committed.baseRevision,
		source: `${candidate.source}\nContinued from the saved receipt.\n`,
	})
	expect(chained.input.editor!.files[summary.path]).toContain('Continued from the saved receipt.')
	const afterChained = await studio.readBody(target)
	expect(afterChained.baseRevision).toBe(chained.baseRevision)
	let unsaved: DocumentInput = structuredClone(chained.input)
	const path = original.files[1]!.path
	unsaved.editor!.files[path] = 'Unsaved human recommendation\n'
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
		const captured = await studio.readBody({ ...target, path })
		expect(captured.files[0]!.source).toContain('Unsaved human')
		unsaved = {
			...unsaved,
			data: { ...unsaved.data, customer: { name: 'Later human input', contact: '林小姐' } },
		}
		await expect(
			studio.applyBodyCandidate({
				...target,
				path,
				baseRevision: captured.baseRevision,
				source: 'Would overwrite',
			}),
		).rejects.toMatchObject({ code: 'STALE_CANDIDATE' })
		const latest = await studio.readBody({ ...target, path })
		const receipt = await studio.applyBodyCandidate({
			...target,
			path,
			baseRevision: latest.baseRevision,
			source: '#let broken = (',
		})
		expect(receipt.editorStatus).toBe('disconnected')
		expect(receipt.editorError).toContain('Editor disconnected')
		expect(receipt.previewError).toBeTruthy()
		expect(receipt.compile).toBeUndefined()
		expect(await studio.getInput(target)).toEqual(receipt.input)
		const invalidSource = await studio.readFile({ projectId: project.id, path })
		expect(invalidSource.content).toBe('#let broken = (')
	} finally {
		await attachment.close()
	}
}, 120000)
