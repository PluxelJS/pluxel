import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sourcePnpmfileBootstrapContents } from '../src/source/execution'
import { diagnoseWorkspaceGovernance } from '../src/workspace/governance'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
	)
})

describe('workspace governance', () => {
	it('accepts a pinned supported pnpm workspace', async () => {
		const root = await fixture({ packageManager: 'pnpm@11.25.0' })
		expect(diagnoseWorkspaceGovernance(root)).toEqual({ errors: [], warnings: [] })
	})

	it('accepts repository-owned tooling with a supported devEngines range', async () => {
		const root = await fixture({
			devEngines: { packageManager: { name: 'pnpm', version: '>=11 <12' } },
		})
		expect(diagnoseWorkspaceGovernance(root).errors).toEqual([])
	})

	it('treats a missing machine-local source overlay as inactive instead of invalid', async () => {
		const root = await fixture({ packageManager: 'pnpm@11.25.0' })
		await writeFile(resolve(root, 'pluxel.sources.jsonc'), '{"version":1,"sources":[]}\n')
		expect(diagnoseWorkspaceGovernance(root)).toEqual({
			errors: [],
			warnings: ['Source overlay is inactive; run `pluxel source install` before using it'],
		})
	})

	it('rejects unsupported package managers and stale source bootstrap files', async () => {
		const root = await fixture({ packageManager: 'pnpm@12.0.0' })
		await writeFile(
			resolve(root, 'pluxel.sources.jsonc'),
			'{"version":1,"sources":["https://example.test/source"]}\n',
		)
		await writeFile(resolve(root, '.pnpmfile.cjs'), '// stale\n')
		expect(diagnoseWorkspaceGovernance(root).errors).toEqual([
			'packageManager must use supported pnpm major 11',
			'Source workspace bootstrap is stale or custom; run `pluxel source install`',
		])
		await writeFile(resolve(root, '.pnpmfile.cjs'), sourcePnpmfileBootstrapContents())
		expect(diagnoseWorkspaceGovernance(root).errors).toEqual([
			'packageManager must use supported pnpm major 11',
		])
	})
})

async function fixture(manifest: Record<string, unknown>): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-workspace-governance-'))
	temporaryRoots.push(root)
	await mkdir(root, { recursive: true })
	await writeFile(
		resolve(root, 'package.json'),
		`${JSON.stringify({ private: true, ...manifest })}\n`,
	)
	await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
	return root
}
