import { afterEach, describe, expect, it } from 'vitest'
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
	stat,
	utimes,
	rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { InputStore } from '../src/backend/inputs.js'
import { WorkspaceStore } from '../src/backend/store.js'
const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'studio-workspace-'))
	roots.push(root)
	const seed = join(root, 'seed')
	await mkdir(join(seed, 'templates'), { recursive: true })
	await mkdir(join(seed, 'fonts'))
	await writeFile(
		join(seed, 'templates/bank-confirmation.typ'),
		'#let letter = json("/inputs/header.json")\n#let accounts = json("/inputs/accounts.json")\n#let body = read("/inputs/body.txt")\n#import "financial-correspondence.typ": correspondence',
	)
	await writeFile(join(seed, 'templates/financial-correspondence.typ'), '// theme')
	await writeFile(join(seed, 'fonts/LICENSE.txt'), 'Example font license')
	await writeFile(join(seed, 'fonts/fixture.otf'), Buffer.from([79, 84, 84, 79, 0, 1]))
	await mkdir(join(root, 'workspace-assets/.agents/skills/typst'), { recursive: true })
	await writeFile(join(root, 'workspace-assets/.agents/skills/typst/SKILL.md'), '# Typst skill')
	await writeFile(join(root, 'workspace-assets/AGENTS.md'), 'Workspace instructions')
	const store = new WorkspaceStore(join(root, 'app'), seed)
	await store.initialize()
	const project = await store.create({ name: 'Finance' })
	return { root, seed, store, project }
}
describe('WorkspaceStore', () => {
	it('rejects removed document data bindings without writing a replacement config', async () => {
		const { store, project } = await fixture()
		const config = await store.readFile(project.id, 'studio.json')
		const value = JSON.parse(config.content)
		value.documents = []
		await expect(
			store.writeFile(project.id, {
				path: config.path,
				expectedVersion: config.version,
				content: JSON.stringify(value),
			}),
		).rejects.toThrow('Invalid studio.json')
		const unchanged = await store.readFile(project.id, config.path)
		expect(unchanged).toEqual(config)
	})
	it('queues Studio reads behind a pending write or directory removal', async () => {
		const { store, project } = await fixture()
		const file = await store.readFile(project.id, 'AGENTS.md')
		const [, observed] = await Promise.all([
			store.writeFile(project.id, {
				path: file.path,
				content: '{"updated":true}',
				expectedVersion: file.version,
			}),
			store.readFile(project.id, file.path),
			store.tree(project.id),
			store.snapshot(project.id),
		])
		expect(observed.content).toBe('{"updated":true}')
		await store.mkdir(project.id, 'draft')
		const before = await store.tree(project.id)
		const draft = before.entries.find((entry) => entry.path === 'draft')!
		const [, after] = await Promise.all([
			store.remove(project.id, { path: 'draft', expectedVersion: draft.version }),
			store.tree(project.id),
		])
		expect(after.entries.some((entry) => entry.path === 'draft')).toBe(false)
	})
	it('invalidates cached content on same-size edits with restored mtime and atomic replacement', async () => {
		const { store, project } = await fixture()
		const path = 'external.txt'
		const absolute = join(project.root, path)
		await writeFile(absolute, 'before')
		const initial = await store.readFile(project.id, path)
		const metadata = await stat(absolute)
		await writeFile(absolute, 'edited')
		await utimes(absolute, metadata.atime, metadata.mtime)
		const changed = await store.readFile(project.id, path)
		expect(changed.content).toBe('edited')
		expect(changed.version).not.toBe(initial.version)
		await writeFile(absolute + '.tmp', 'atomic')
		await utimes(absolute + '.tmp', metadata.atime, metadata.mtime)
		await rename(absolute + '.tmp', absolute)
		const replaced = await store.readFile(project.id, path)
		expect(replaced.content).toBe('atomic')
		expect(replaced.version).not.toBe(changed.version)
	})
	it('exposes a broken studio.json for repair while refusing compilation snapshots', async () => {
		const { store, project, root } = await fixture()
		const original = await store.readFile(project.id, 'studio.json')
		await writeFile(join(project.root, 'studio.json'), '{broken')
		const tree = await store.tree(project.id)
		expect(tree.configError).toContain('Invalid studio.json')
		expect(tree.documents).toHaveLength(5)
		const broken = await store.readFile(project.id, 'studio.json')
		expect(broken.content).toBe('{broken')
		await expect(store.snapshot(project.id)).rejects.toThrow('Invalid studio.json')
		await expect(store.materialize(project.id, join(root, 'failed-snapshot'))).rejects.toThrow(
			'Invalid studio.json',
		)
		await store.writeFile(project.id, {
			path: 'studio.json',
			content: original.content,
			expectedVersion: broken.version,
		})
		const repaired = await store.tree(project.id)
		expect(repaired.configError).toBeUndefined()
		expect(repaired.documents).toHaveLength(5)
	})
	it('uses real files, detects external edits and serializes competing saves', async () => {
		const { store, project, root, seed } = await fixture()
		const file = await store.readFile(project.id, 'AGENTS.md')
		const tree = await store.tree(project.id)
		await writeFile(join(project.root, file.path), '{"external":true}')
		const changedTree = await store.tree(project.id)
		expect(changedTree.revision).not.toBe(tree.revision)
		await expect(
			store.writeFile(project.id, { ...file, content: '{}', expectedVersion: file.version }),
		).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		const fresh = await store.readFile(project.id, file.path)
		const results = await Promise.allSettled([
			store.writeFile(project.id, {
				path: file.path,
				content: '{"winner":1}',
				expectedVersion: fresh.version,
			}),
			store.writeFile(project.id, {
				path: file.path,
				content: '{"winner":2}',
				expectedVersion: fresh.version,
			}),
		])
		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
		const restarted = new WorkspaceStore(join(root, 'app'), seed)
		await restarted.initialize()
		expect(await restarted.readFile(project.id, file.path)).toMatchObject({
			content: '{"winner":1}',
		})
		await restarted.forget(project.id)
		expect(await restarted.list()).toEqual([])
		expect(await readFile(join(project.root, file.path), 'utf8')).toBe('{"winner":1}')
	})
	it('opens an existing folder without writing configuration and snapshots all project files', async () => {
		const { store, root } = await fixture()
		const external = join(root, 'external')
		await mkdir(external)
		await writeFile(join(external, 'report.typ'), '#text("existing")')
		const opened = await store.open(external)
		const openedTree = await store.tree(opened.id)
		expect(openedTree.documents).toEqual([])
		expect(await readdir(external)).toEqual(['report.typ'])
		const reopened = await store.open(external)
		expect(reopened.id).toBe(opened.id)
		const snapshot = await store.materialize(opened.id, join(root, 'snapshot'))
		expect(snapshot.files['report.typ']).toBe('#text("existing")')
		expect(await readFile(join(root, 'snapshot/report.typ'), 'utf8')).toBe(
			snapshot.files['report.typ'],
		)
	})
	it('round trips a real ZIP with nested skills, fonts, licenses and empty directories', async () => {
		const { store, project, root } = await fixture()
		await store.mkdir(project.id, 'empty')
		const bytes = await store.export(project.id)
		expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe('PK')
		const imported = await store.import(bytes)
		expect(imported.id).not.toBe(project.id)
		const importedTree = await store.tree(imported.id)
		const originalTree = await store.tree(project.id)
		expect(importedTree.entries.map((entry) => entry.path)).toEqual(
			originalTree.entries.map((entry) => entry.path),
		)
		const snapshot = await store.materialize(imported.id, join(root, 'snapshot'))
		expect(snapshot.files['.agents/skills/typst/SKILL.md']).toBe('# Typst skill')
		expect(snapshot.files['共享/字体/LICENSE.txt']).toBe('Example font license')
		expect(snapshot.assets).toContainEqual({ path: '共享/字体/fixture.otf', size: 6 })
		expect(snapshot.files['报表/银行询证函/data.json']).toBeUndefined()
		expect(snapshot.files['报表/银行账户余额汇总表/data.json']).toBeUndefined()
		expect(Object.hasOwn(snapshot.config, 'documents')).toBe(false)
		expect(snapshot.files['报表/银行询证函/排版.typ']).toContain('../../共享/主题/财务函件.typ')
		expect(snapshot.files['报表/银行询证函/银行询证函.ts']).toContain('v.optional')
	})
	it('rejects traversal, ZIP links, duplicate ZIP paths, oversized entries and symlink workspaces', async () => {
		const { store, project, root } = await fixture()
		await expect(store.readFile(project.id, '../outside')).rejects.toThrow('path')
		const target = join(root, 'linked')
		await symlink(project.root, target)
		await expect(store.open(target)).rejects.toThrow('Symbolic')
		const bad = zipSync({ '../escape.txt': Buffer.from('bad') })
		const before = await readdir(join(root, 'app/projects'))
		await expect(store.import(bad)).rejects.toThrow(/relative path|workspace path/)
		const link = Buffer.from(zipSync({ 'link.txt': Buffer.from('outside') }))
		const central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
		link.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38)
		await expect(store.import(link)).rejects.toThrow('links')
		const duplicate = Buffer.from(zipSync({ 'a.txt': Buffer.from('a'), 'b.txt': Buffer.from('b') }))
		for (
			let offset = duplicate.indexOf('b.txt');
			offset !== -1;
			offset = duplicate.indexOf('b.txt', offset + 1)
		)
			duplicate.write('a.txt', offset)
		await expect(store.import(duplicate)).rejects.toThrow('Duplicate')
		const bomb = Buffer.from(zipSync({ 'bomb.txt': Buffer.from('small') }))
		const bombCentral = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
		bomb.writeUInt32LE(65 * 1024 * 1024, bombCentral + 24)
		await expect(store.import(bomb)).rejects.toThrow(/size|limit/)
		expect(await readdir(join(root, 'app/projects'))).toEqual(before)
		await symlink(join(root, 'seed/fonts/LICENSE.txt'), join(project.root, 'linked.txt'))
		await expect(store.snapshot(project.id)).rejects.toThrow('Symbolic')
	})
	it('protects directory operations from external edits and preserves binary assets', async () => {
		const { store, project } = await fixture()
		await store.mkdir(project.id, 'drafts')
		const originalTree = await store.tree(project.id)
		const original = originalTree.entries.find((entry) => entry.path === 'drafts')!
		await writeFile(join(project.root, 'drafts/new.typ'), 'external')
		await expect(
			store.remove(project.id, { path: 'drafts', expectedVersion: original.version }),
		).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		const currentTree = await store.tree(project.id)
		const current = currentTree.entries.find((entry) => entry.path === 'drafts')!
		await store.rename(project.id, {
			path: 'drafts',
			to: 'renamed',
			expectedVersion: current.version,
		})
		await store.putAsset(project.id, 'renamed/custom.bin', new Uint8Array([0, 1, 2]))
		await expect(
			store.putAsset(project.id, 'renamed/custom.bin', new Uint8Array([3])),
		).rejects.toThrow('changed')
		const snapshot = await store.snapshot(project.id)
		expect(snapshot.assets).toContainEqual({ path: 'renamed/custom.bin', size: 3 })
	})
})

it('discovers broken report entries without executing them and keeps the convention on rename', async () => {
	const { store, project } = await fixture()
	const created = await store.createReport(project.id, '报表/custom')
	expect(created).toEqual({ entry: '报表/custom/custom.ts', name: 'custom' })
	const file = await store.readFile(project.id, created.entry)
	expect(file.content).toContain('v.optional')
	await store.writeFile(project.id, {
		path: file.path,
		expectedVersion: file.version,
		content: 'throw new Error("Must not execute discovery"); export const schema = ;',
	})
	await store.writeFile(project.id, {
		path: '报表/custom/helper.ts',
		expectedVersion: null,
		content: 'throw new Error("ordinary helper")',
	})
	const tree = await store.tree(project.id)
	expect(tree.documents).toContainEqual(created)
	expect(tree.documents.some((doc) => doc.entry.endsWith('helper.ts'))).toBe(false)
	const directory = tree.entries.find((entry) => entry.path === '报表/custom')!
	const moved = await store.rename(project.id, {
		path: directory.path,
		to: '报表/renamed',
		expectedVersion: directory.version,
	})
	expect(moved.documents).toContainEqual({ entry: '报表/renamed/renamed.ts', name: 'renamed' })
	expect(moved.entries.some((entry) => entry.path === '报表/renamed/custom.ts')).toBe(false)
	await expect(store.createReport(project.id, '报表/renamed')).rejects.toThrow('File changed')
	const renamedSource = await store.readFile(project.id, '报表/renamed/renamed.ts')
	expect(renamedSource.content).toContain('Must not execute')
})
it('preserves persisted inputs across report and ancestor directory rename, rejecting entry collisions', async () => {
	const { root, seed, project } = await fixture()
	const inputs = new InputStore(join(root, 'inputs'))
	const store = new WorkspaceStore(join(root, 'app'), seed, {}, (id, entries, revisions) =>
		inputs.copyEntries(id, entries, revisions),
	)
	await store.initialize()
	const source = '报表/银行询证函/银行询证函.ts'
	await inputs.set(project.id, source, { data: { title: 'User data' }, expectedVersion: null })
	const before = await store.tree(project.id)
	const renamed = await store.rename(project.id, {
		path: '报表/银行询证函',
		to: '报表/custom',
		expectedVersion: before.entries.find((entry) => entry.path === '报表/银行询证函')!.version,
	})
	const renamedInput = await inputs.get(project.id, '报表/custom/custom.ts')
	expect(renamedInput.data).toEqual({
		title: 'User data',
	})
	await store.rename(project.id, {
		path: '报表',
		to: 'archive',
		expectedVersion: renamed.entries.find((entry) => entry.path === '报表')!.version,
	})
	const archivedInput = await inputs.get(project.id, 'archive/custom/custom.ts')
	expect(archivedInput.data).toEqual({
		title: 'User data',
	})
	await store.writeFile(project.id, {
		path: 'archive/custom/taken.ts',
		expectedVersion: null,
		content: 'existing',
	})
	const collision = await store.tree(project.id)
	await expect(
		store.rename(project.id, {
			path: 'archive/custom',
			to: 'archive/taken',
			expectedVersion: collision.entries.find((entry) => entry.path === 'archive/custom')!.version,
		}),
	).rejects.toThrow('File changed')
	const afterCollisionInput = await inputs.get(project.id, 'archive/custom/custom.ts')
	expect(afterCollisionInput.data).toEqual({
		title: 'User data',
	})
	const afterCollision = await store.tree(project.id)
	expect(afterCollision.documents.some((doc) => doc.entry === 'archive/custom/custom.ts')).toBe(
		true,
	)
})
it('renames region configuration and its complete draft together and removes the draft with its report', async () => {
	const { root, seed, project } = await fixture()
	const inputs = new InputStore(join(root, 'inputs'))
	const store = new WorkspaceStore(
		join(root, 'app'),
		seed,
		{},
		(id, entries, revisions) => inputs.copyEntries(id, entries, revisions),
		(id, entries) => inputs.removeEntries(id, entries),
	)
	await store.initialize()
	const before = await store.tree(project.id)
	const source = '报表/客户服务报告/客户服务报告.ts'
	const configFile = await store.readFile(project.id, source.replace('.ts', '.editor.json'))
	const config = JSON.parse(configFile.content)
	await inputs.set(project.id, source, {
		data: { customer: { name: 'Saved user' } },
		editor: {
			formatVersion: 1,
			templateId: source,
			templateRevision: before.revision,
			regions: config.defaults,
		},
		expectedVersion: null,
	})
	const renamed = await store.rename(project.id, {
		path: '报表/客户服务报告',
		to: '报表/客户报告',
		expectedVersion: before.entries.find((entry) => entry.path === '报表/客户服务报告')!.version,
	})
	expect(renamed.entries.some((entry) => entry.path === '报表/客户报告/客户报告.editor.json')).toBe(
		true,
	)
	const saved = await inputs.get(project.id, '报表/客户报告/客户报告.ts')
	expect(saved).toMatchObject({
		data: { customer: { name: 'Saved user' } },
		editor: { templateId: '报表/客户报告/客户报告.ts', templateRevision: renamed.revision },
	})
	expect(saved.editor?.regions).toEqual(config.defaults)
	await store.remove(project.id, {
		path: '报表/客户报告',
		expectedVersion: renamed.entries.find((entry) => entry.path === '报表/客户报告')!.version,
	})
	expect(await inputs.get(project.id, '报表/客户报告/客户报告.ts')).toEqual({
		data: {},
		storageVersion: null,
	})
	expect(await inputs.get(project.id, source)).toEqual({ data: {}, storageVersion: null })
})
it('rolls source rename back when saving renamed input mappings fails', async () => {
	const { root, seed, project } = await fixture()
	const store = new WorkspaceStore(join(root, 'app'), seed, {}, async () => {
		throw new Error('Input storage unavailable')
	})
	await store.initialize()
	const before = await store.tree(project.id)
	await expect(
		store.rename(project.id, {
			path: '报表/银行询证函',
			to: '报表/custom',
			expectedVersion: before.entries.find((entry) => entry.path === '报表/银行询证函')!.version,
		}),
	).rejects.toThrow('Input storage unavailable')
	const rolledBack = await store.tree(project.id)
	expect(rolledBack.documents).toEqual(before.documents)
})
