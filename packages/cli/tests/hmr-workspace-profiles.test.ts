import { describe, expect, it } from 'bun:test'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
import { diagnoseWorkspace, readHmrConfigV1, writeHmrConfigV1, type PluxelHmrConfigV1 } from '@pluxel/cli/hmr'

describe('@pluxel/cli/hmr workspace profiles', () => {
	it('parses config strictly (unknown fields rejected)', async () => {
		await using fixture = await createFixture({
			'pluxel.hmr.jsonc': '{ "version": 1, "profile": "dev", "profiles": { "dev": { "enabled": [] } }, "foo": 1 }',
		})
		expect(() => readHmrConfigV1(resolve(fixture.path, 'pluxel.hmr.jsonc'))).toThrow()
	})

	it('diagnoseWorkspace resolves enabledEntries, include entries, and watchRoots', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', "  - 'packages/*'", ''].join('\n'),
			'packages/shared/package.json': JSON.stringify({ name: 'pluxel-shared', version: '0.0.0' }, null, 2),
			'packages/shared/src/index.ts': 'export const shared = 1\n',
			'packages/plugin-a/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-a',
					version: '0.0.0',
					type: 'module',
					dependencies: { 'pluxel-shared': 'workspace:*' },
					exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
				},
				null,
				2,
			),
			'packages/plugin-a/src/index.ts': 'export const pluginA = 1\n',
			'packages/plugins-host/package.json': JSON.stringify({ name: '@pluxel/plugins-host', version: '0.0.0' }, null, 2),
			'packages/plugins-host/src/demo/PluginEventsDemo.ts': 'export const demo = 1\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.hmr.jsonc')

		const cfg: PluxelHmrConfigV1 = {
			version: 1,
			profile: 'dev',
			defaults: {
				roots: 'auto',
				exclude: ['**/node_modules/**', '**/dist/**'],
			},
			profiles: {
				dev: {
					enabled: ['pluxel-plugin-a'],
					include: ['packages/plugins-host/src/demo/**/*.ts'],
				},
			},
		}
		writeHmrConfigV1(configPath, cfg, { headerComment: '' })

		const res = await diagnoseWorkspace({ rootDir, configPath, env: {} })
		expect(res.ok).toBe(true)
		if (!res.ok) return

		expect(res.snapshot.activeProfile).toBe('dev')
		expect(res.snapshot.enabled).toEqual(['pluxel-plugin-a'])

		expect(res.snapshot.enabledEntries[0]).toBe('packages/plugin-a/src/index.ts')
		expect(res.snapshot.enabledEntries).toContain('packages/plugins-host/src/demo/PluginEventsDemo.ts')
		expect(res.snapshot.includedEntries).toEqual(['packages/plugins-host/src/demo/PluginEventsDemo.ts'])

		// watchRoots includes the enabled plugin package + its workspace deps closure + include-containing package
		expect(res.snapshot.watchRoots).toContain('packages/plugin-a')
		expect(res.snapshot.watchRoots).toContain('packages/plugins-host')

		expect(res.snapshot.includeGlobs.length).toBeGreaterThan(0)
		expect(res.snapshot.excludeGlobs).toEqual(['**/dist/**', '**/node_modules/**'])
	})
})
