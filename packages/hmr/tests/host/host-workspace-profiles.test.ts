import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { bootPlannedHmrHost, planHmrHost } from '../../src/host'
import { createTestHmrHost } from '../support/test-host'

describe('@pluxel/hmr/host snapshot contract', () => {
	it('refuses to start when snapshot is missing', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
		})

		// @ts-expect-error runtime contract check: snapshot is required
		await expect(createTestHmrHost({ fs: fixture.fs, root: fixture.path })).rejects.toThrow(
			/snapshot is required/i,
		)
	})

	it('boots deterministically when snapshot is provided', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})

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
		const res = await createTestHmrHost({
			fs: fixture.fs,
			root: fixture.path,
			storage: {
				configFile: '.pluxel/hmr/config.json',
				seedConfig: false,
			},
			snapshot,
		})
		expect(res.root).toBe(resolve(fixture.path))
		expect(fixture.fs.existsSync(resolve(fixture.path, '.pluxel/hmr/config.dev.json'))).toBe(true)
	}, 15_000)

	it('separates host planning from startup side effects', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})

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

		const plan = planHmrHost({
			fs: fixture.fs,
			root: fixture.path,
			storage: {
				configFile: '.pluxel/hmr/config.json',
				seedConfig: false,
			},
			snapshot,
			logging: false,
			chdir: false,
		})

		expect(fixture.fs.existsSync(resolve(fixture.path, '.pluxel/hmr/config.dev.json'))).toBe(false)

		const res = await bootPlannedHmrHost(plan)
		expect(fixture.fs.existsSync(resolve(fixture.path, '.pluxel/hmr/config.dev.json'))).toBe(true)
		await res.ctx.effects.dispose()
	}, 15_000)
})
