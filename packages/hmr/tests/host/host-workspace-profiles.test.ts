import { createHmrHost } from '@pluxel/hmr/host'
import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

describe('@pluxel/hmr/host snapshot contract', () => {
	it('refuses to start when workspaceSnapshot is missing', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
		})

		const prevCwd = process.cwd()
		try {
			// @ts-expect-error runtime contract check: workspaceSnapshot is required
			await expect(createHmrHost({ root: fixture.path, logging: false })).rejects.toThrow(
				/workspaceSnapshot is required/i,
			)
		} finally {
			process.chdir(prevCwd)
		}
	})

	it('boots deterministically when workspaceSnapshot is provided', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})

		const prevCwd = process.cwd()
		try {
			const snapshot: HmrWorkspaceSnapshot = {
				activeProfile: 'dev',
				roots: ['packages/a'],
				enabled: ['pluxel-plugin-a'],
				builtinPackages: [],
				enabledEntries: ['packages/a/src/index.ts'],
				includedEntries: [],
				watchRoots: ['packages/a'],
				includeGlobs: [],
				excludeGlobs: [],
			}
			const res = await createHmrHost({
				root: fixture.path,
				logging: false,
				workspaceSnapshot: snapshot,
			})
			expect(res.root).toBe(resolve(fixture.path))
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)
})
