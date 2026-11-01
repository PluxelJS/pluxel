import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { InputStore } from '../src/backend/inputs.js'
import { WorkspaceStore } from '../src/backend/store.js'

it('atomically accepts source and raw JSON with workspace CAS and retains a concurrent winner', async () => {
	const root = await mkdtemp(join(tmpdir(), 'studio-input-source-'))
	try {
		const dir = join(root, 'workspace')
		await mkdir(join(dir, 'report'), { recursive: true })
		await writeFile(join(dir, 'studio.json'), JSON.stringify({ name: 'test', fonts: [] }))
		await writeFile(join(dir, 'report/report.ts'), 'export default {}')
		await writeFile(
			join(dir, 'report/report.editor.json'),
			JSON.stringify({ sources: [{ path: 'workspace.typ' }] }),
		)
		await writeFile(join(dir, 'report/workspace.typ'), '原文 // retained\n')
		await writeFile(join(dir, 'report/data.json'), '{ "raw": " input " }\n')
		const workspace = new WorkspaceStore(join(root, 'app'), root)
		await workspace.initialize()
		const project = await workspace.open(dir),
			store = new InputStore(workspace)
		const initial = await store.get(project.id, 'report/report.ts')
		const writes = await Promise.allSettled(
			['first', 'second'].map((text) =>
				store.set(project.id, 'report/report.ts', {
					data: { raw: text },
					editor: { files: { ...initial.editor!.files, 'report/workspace.typ': text } },
					expectedVersion: initial.storageVersion,
				}),
			),
		)
		expect(writes.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
		expect(writes[1]).toMatchObject({ reason: { code: 'DRAFT_VERSION_CONFLICT' } })
		expect(await readFile(join(dir, 'report/workspace.typ'), 'utf8')).toBe('first')
		expect(JSON.parse(await readFile(join(dir, 'report/data.json'), 'utf8'))).toEqual({
			raw: 'first',
		})
		const current = await store.get(project.id, 'report/report.ts')
		await expect(
			store.set(project.id, 'report/report.ts', {
				...current,
				editor: { files: { ...current.editor!.files, 'report/report.ts': 'unauthorized' } },
				expectedVersion: current.storageVersion,
			}),
		).rejects.toMatchObject({ code: 'READ_ONLY' })
		expect(await store.get(project.id, 'report/report.ts')).toEqual(current)
		const invalid = await store.set(project.id, 'report/report.ts', {
			...current,
			editor: { files: { ...current.editor!.files, 'report/workspace.typ': '#let broken = (' } },
			expectedVersion: current.storageVersion,
		})
		expect(invalid.editor!.files['report/workspace.typ']).toBe('#let broken = (')
		const originalWrite = workspace.writeFiles.bind(workspace)
		vi.spyOn(workspace, 'writeFiles').mockImplementationOnce(async (id, write) => {
			const receipt = await originalWrite(id, write)
			const committed = await workspace.readFile(id, 'report/workspace.typ')
			await workspace.writeFile(id, {
				path: committed.path,
				content: 'Later writer',
				expectedVersion: committed.version,
			})
			return receipt
		})
		const receipt = await store.set(project.id, 'report/report.ts', {
			...invalid,
			editor: { files: { ...invalid.editor!.files, 'report/workspace.typ': 'Own commit' } },
			expectedVersion: invalid.storageVersion,
		})
		expect(receipt.editor!.files['report/workspace.typ']).toBe('Own commit')
		const later = await store.get(project.id, 'report/report.ts')
		expect(later.editor!.files['report/workspace.typ']).toBe('Later writer')

		await writeFile(join(dir, 'report/data.json'), '{ broken')
		await expect(store.get(project.id, 'report/report.ts')).rejects.toThrow(SyntaxError)
		expect(await readFile(join(dir, 'report/data.json'), 'utf8')).toBe('{ broken')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
