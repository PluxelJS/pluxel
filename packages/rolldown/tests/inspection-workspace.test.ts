import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPackages, resolveInspectionPackage } from '../src/inspect/workspace.ts'

const roots: string[] = []
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-inspect-workspace-'))
	roots.push(root)
	return root
}
async function manifest(root: string, value: object) {
	await mkdir(root, { recursive: true })
	await writeFile(join(root, 'package.json'), JSON.stringify(value))
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('inspection workspace discovery', () => {
	it('does not infer membership from packages and apps directory names', async () => {
		const root = await fixture()
		await manifest(root, { name: 'root' })
		await manifest(join(root, 'packages/hidden'), { name: 'hidden' })
		await manifest(join(root, 'apps/hidden'), { name: 'hidden-app' })
		const packages = await discoverPackages(root)
		expect(packages.map((item) => item.manifest.name)).toEqual(['root'])
	})

	it('uses pnpm membership, exclusions and named root while ignoring other YAML arrays', async () => {
		const root = await fixture()
		await manifest(root, { name: 'root' })
		await manifest(join(root, 'plugins/one'), { name: 'one' })
		await manifest(join(root, 'plugins/skip'), { name: 'skip' })
		await manifest(join(root, 'unrelated'), { name: 'unrelated' })
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			"packages:\n  - plugins/*\n  - '!plugins/skip'\nonlyBuiltDependencies:\n  - unrelated\n",
		)
		const packages = await discoverPackages(root)
		expect(packages.map((item) => item.manifest.name).sort()).toEqual(['one', 'root'])
	})

	it('rejects duplicate names and malformed manifests instead of choosing a winner', async () => {
		const root = await fixture()
		await manifest(root, { workspaces: ['modules/*'] })
		await manifest(join(root, 'modules/a'), { name: 'same' })
		await manifest(join(root, 'modules/b'), { name: 'same' })
		await expect(discoverPackages(root)).rejects.toMatchObject({ code: 'ambiguous_package' })
		await writeFile(join(root, 'modules/b/package.json'), '{broken')
		await expect(discoverPackages(root)).rejects.toMatchObject({ code: 'analysis_unavailable' })
	})

	it('reports unsupported YAML membership instead of claiming an empty workspace', async () => {
		const root = await fixture()
		await manifest(root, { name: 'root' })
		for (const source of [
			'packages: ["plugins/*"]\n',
			'packages:\n- plugins/*\n',
			'"packages":\n  - plugins/*\n',
			'  packages:\n    - plugins/*\n',
		]) {
			await writeFile(join(root, 'pnpm-workspace.yaml'), source)
			await expect(discoverPackages(root)).rejects.toMatchObject({ code: 'analysis_unavailable' })
		}
	})

	it('rejects workspace patterns outside the project while allowing source package symlinks', async () => {
		const root = await fixture()
		const source = await fixture()
		await manifest(source, { name: 'source' })
		for (const pattern of ['../*', `${source}/*`]) {
			await manifest(root, { workspaces: [pattern] })
			await expect(discoverPackages(root)).rejects.toMatchObject({ code: 'analysis_unavailable' })
		}
		await manifest(root, { workspaces: ['linked'] })
		await symlink(source, join(root, 'linked'), 'dir')
		const packages = await discoverPackages(root)
		expect(packages.some((item) => item.root === source)).toBe(true)
	})

	it('observes cancellation before discovery or installed dependency traversal', async () => {
		const root = await fixture()
		const reason = new Error('cancelled')
		const signal = AbortSignal.abort(reason)
		await expect(discoverPackages(root, { signal })).rejects.toBe(reason)
		await expect(resolveInspectionPackage(root, 'missing', [], { signal })).rejects.toBe(reason)
	})

	it('resolves an installed source symlink even when package.json is hidden and build is absent', async () => {
		const root = await fixture()
		const source = await fixture()
		await manifest(root, { name: 'root' })
		await manifest(source, { name: '@fixture/plugin', exports: { '.': './missing-dist.js' } })
		const link = join(root, 'node_modules/@fixture/plugin')
		await mkdir(dirname(link), { recursive: true })
		await symlink(source, link, 'dir')
		const found = await resolveInspectionPackage(
			root,
			'@fixture/plugin',
			await discoverPackages(root),
		)
		expect(found.root).toBe(source)
		await expect(resolveInspectionPackage(root, '../plugin', [])).rejects.toMatchObject({
			code: 'invalid_input',
		})
	})

	it('rediscovers membership and symlink targets on the next query', async () => {
		const root = await fixture()
		await manifest(root, { workspaces: ['modules/*'] })
		expect(await discoverPackages(root)).toHaveLength(1)
		await manifest(join(root, 'modules/new'), { name: 'new' })
		expect(await discoverPackages(root)).toHaveLength(2)
		const source = await fixture()
		await manifest(source, { name: 'newer' })
		const link = join(root, 'node_modules/external')
		await mkdir(dirname(link), { recursive: true })
		await symlink(join(root, 'modules/new'), link, 'dir')
		const before = await resolveInspectionPackage(root, 'external', [])
		expect(before.manifest.name).toBe('new')
		await rm(link)
		await symlink(source, link, 'dir')
		const after = await resolveInspectionPackage(root, 'external', [])
		expect(after.manifest.name).toBe('newer')
	})
})
