import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { InputStore } from '../src/backend/inputs.js'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { sourceFiles } from '../src/shared/source-files.js'
import { studioFixture } from './studio-fixture.js'
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

it('captures read-only PNG bytes with source, copies its figure, and saves only text', async () => {
	await using fixture = await studioFixture('Image source resources')
	const { studio, project } = fixture
	const target = { projectId: project.id, entry: '报表/客户服务报告/客户服务报告.ts' }
	const imagePath = '报表/客户服务报告/pixel.png'
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
		'base64',
	)
	await studio.putAsset({ projectId: project.id, path: imagePath, bytes: png })
	const input = await studio.getInput(target)
	expect(input.assets).toEqual([{ path: imagePath, size: png.length, bytes: png }])
	expect(input.editor!.files).not.toHaveProperty(imagePath)
	const path = '报表/客户服务报告/summary.typ'
	const source = '#figure(image("pixel.png", width: 12pt), caption: [Pixel]) <fig:pixel>'
	const files = sourceFiles(input)
	files[path] = source
	const core = createTypstSourceProject({ files, writablePaths: [path] })
	expect(
		core.copy({
			baseRevision: 0,
			path,
			from: 0,
			to: Buffer.byteLength(source),
			toPath: path,
			at: Buffer.byteLength(source),
		}),
	).toMatchObject({ ok: true })
	const copied = core.open(path).source
	expect(copied).toContain('<fig:pixel-copy>')
	const saved = await studio.setInput({
		...target,
		data: input.data,
		editor: { files: { ...input.editor!.files, [path]: copied } },
		expectedVersion: input.storageVersion,
	})
	expect(saved.assets).toEqual(input.assets)
	expect(await readFile(join(project.root, imagePath))).toEqual(png)
	const compiled = await studio.compile({ ...target, ...saved, clientRevision: 1 })
	expect(compiled.pageCount).toBeGreaterThan(0)
	const reopened = createTypstSourceProject({ files: sourceFiles(await studio.getInput(target)) })
	expect(reopened.snapshot().files[imagePath]).toEqual(png)
	expect(reopened.open(path).labels).toHaveLength(2)
}, 120000)
