import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeWorkspaceFs } from '../src/workspace/fs.ts'
import { crawlFilesAbsWithFs } from '../src/workspace/fswalk.ts'
import { loadWorkspaceInfo, loadWorkspaceInfoWithFs } from '../src/workspace/info.ts'

const roots: string[] = []
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-workspace-info-'))
	roots.push(root)
	await writeFile(join(root, 'package.json'), '{"name":"root"}')
	return root
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace member discovery', () => {
	it('keeps an explicit single package even when packages and apps directories exist', async () => {
		const root = await fixture()
		await mkdir(join(root, 'packages/hidden'), { recursive: true })
		await writeFile(join(root, 'packages/hidden/package.json'), '{"name":"hidden"}')
		const info = await loadWorkspaceInfo(root)
		expect(info.isMonorepo).toBe(false)
		expect(info.patterns).toEqual([])
		expect(info.packageDirs).toEqual([])
	})

	it('reads only pnpm membership and rejects malformed selected manifests', async () => {
		const root = await fixture()
		await mkdir(join(root, 'plugins/good'), { recursive: true })
		await mkdir(join(root, 'plugins/bad'), { recursive: true })
		await writeFile(join(root, 'plugins/good/package.json'), '{"name":"good"}')
		await writeFile(join(root, 'plugins/bad/package.json'), '{broken')
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
		await expect(loadWorkspaceInfo(root)).rejects.toThrow(join(root, 'plugins/bad/package.json'))
		await writeFile(join(root, 'plugins/bad/package.json'), '{"name":"bad"}')
		const discovered = await loadWorkspaceInfo(root)
		expect(discovered.packageDirs).toEqual([join(root, 'plugins/bad'), join(root, 'plugins/good')])
	})

	it('rejects unsupported declarations, missing literal members and unknown roots', async () => {
		const root = await fixture()
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [')
		await expect(loadWorkspaceInfo(root)).rejects.toThrow('pnpm-workspace.yaml')
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - ../outside\n')
		await expect(loadWorkspaceInfo(root)).rejects.toThrow('Unsupported workspace pattern')
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - missing\n')
		await expect(loadWorkspaceInfo(root)).rejects.toThrow(
			'Declared workspace member does not exist',
		)
		await expect(loadWorkspaceInfo(join(root, 'unknown'))).rejects.toThrow(
			'Workspace root must contain package.json',
		)
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
		const empty = await loadWorkspaceInfo(root)
		expect(empty.packageDirs).toEqual([])
	})

	it('rejects a failed candidate scan rather than storing an empty result', async () => {
		const root = await fixture()
		await expect(crawlFilesAbsWithFs({ roots: [join(root, 'missing')] })).rejects.toThrow(
			'Cannot inspect scan root',
		)
		const fs = {
			...nodeWorkspaceFs,
			promises: {
				...nodeWorkspaceFs.promises,
				readdir: (async () => {
					throw Object.assign(new Error('denied'), { code: 'EACCES' })
				}) as typeof nodeWorkspaceFs.promises.readdir,
			},
		}
		await expect(crawlFilesAbsWithFs({ roots: [root] }, fs)).rejects.toThrow(
			'Cannot enumerate directory',
		)
	})

	it('preserves directory enumeration failure instead of returning partial members', async () => {
		const root = await fixture()
		await mkdir(join(root, 'plugins'), { recursive: true })
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
		const fs = {
			...nodeWorkspaceFs,
			promises: {
				...nodeWorkspaceFs.promises,
				readdir: (async () => {
					throw Object.assign(new Error('denied'), { code: 'EACCES' })
				}) as typeof nodeWorkspaceFs.promises.readdir,
			},
		}
		await expect(loadWorkspaceInfoWithFs(root, fs)).rejects.toThrow(
			'Cannot enumerate workspace directory',
		)
	})
})
