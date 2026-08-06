import {
	diagnoseLoaderHmrWorkspace,
	type LoaderHmrWorkspaceFs,
	type PluxelLoaderHmrConfigV2,
	readLoaderHmrConfigV2,
	writeLoaderHmrConfigV2,
} from '@pluxel/runtime-dynamic/hmr/diagnose'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

describe('@pluxel/runtime-dynamic/hmr/diagnose workspace profiles', () => {
	it('parses version 2 strictly and rejects version 1 with a migration diagnostic', async () => {
		await using fixture = await createFixture({
			'unknown.jsonc':
				'{ "version": 2, "profile": "hmr", "profiles": { "hmr": { "enabled": [] } }, "foo": 1 }',
			'legacy.jsonc':
				'{ "version": 1, "profile": "hmr", "profiles": { "hmr": { "enabled": [], "builtin": [] } } }',
		})
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		expect(() => readLoaderHmrConfigV2(resolve(fixture.path, 'unknown.jsonc'), fs)).toThrow(
			/unknown.*foo/i,
		)
		expect(() => readLoaderHmrConfigV2(resolve(fixture.path, 'legacy.jsonc'), fs)).toThrow(
			/version 1 is unsupported.*version to 2/i,
		)
	})

	it('returns a friendly error when the config file is missing', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': 'packages: []\n',
		})
		const configPath = resolve(fixture.path, 'pluxel.loader.hmr.jsonc')
		const res = await diagnoseLoaderHmrWorkspace({
			rootDir: fixture.path,
			configPath,
			env: {},
			fs: fixture.fs as LoaderHmrWorkspaceFs,
		})
		expect(res.ok).toBe(false)
		if (res.ok !== false) return
		expect(res.errors[0]).toContain('Missing config file')
	})

	it('resolves enabled entries, include entries, and watch roots without a fixed-plugin profile', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', "  - 'packages/*'", ''].join('\n'),
			'packages/shared/package.json': JSON.stringify({
				name: 'pluxel-shared',
				version: '0.0.0',
			}),
			'packages/shared/src/index.ts': 'export const shared = 1\n',
			'packages/plugin-a/package.json': JSON.stringify({
				name: 'pluxel-plugin-a',
				version: '0.0.0',
				type: 'module',
				dependencies: { 'pluxel-shared': 'workspace:*' },
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'packages/plugin-a/src/index.ts': 'export const pluginA = 1\n',
			'packages/plugins-host/package.json': JSON.stringify({
				name: '@pluxel/plugins-host',
				version: '0.0.0',
			}),
			'packages/plugins-host/src/demo/PluginEventsDemo.ts': 'export const demo = 1\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		const config: PluxelLoaderHmrConfigV2 = {
			version: 2,
			profile: 'hmr',
			defaults: { roots: 'auto', exclude: ['**/node_modules/**', '**/dist/**'] },
			profiles: {
				hmr: {
					enabled: ['pluxel-plugin-a'],
					include: ['packages/plugins-host/src/demo/**/*.ts'],
				},
			},
		}
		writeLoaderHmrConfigV2(configPath, config, { headerComment: '', fs })

		const res = await diagnoseLoaderHmrWorkspace({ rootDir, configPath, env: {}, fs })
		expect(res.ok).toBe(true)
		if (res.ok !== true) return
		expect(res.snapshot.enabled).toEqual(['pluxel-plugin-a'])
		expect(res.snapshot.enabledEntries).toContain('packages/plugin-a/src/index.ts')
		expect(res.snapshot.includedEntries).toEqual([
			'packages/plugins-host/src/demo/PluginEventsDemo.ts',
		])
		expect(res.snapshot.watchRoots).toEqual(
			expect.arrayContaining(['packages/plugin-a', 'packages/shared', 'packages/plugins-host']),
		)
		expect(res.snapshot).not.toHaveProperty('builtinPackages')
		expect(res.snapshot).not.toHaveProperty('builtinsFromDist')
	})

	it('keeps omitPackages as a general discovery exclusion', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - plugins/*', ''].join('\n'),
			'plugins/a/package.json': JSON.stringify({
				name: 'pluxel-plugin-a',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'plugins/a/src/index.ts': 'export const plugins = []\n',
			'plugins/b/package.json': JSON.stringify({
				name: 'pluxel-plugin-b',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'plugins/b/src/index.ts': 'export const plugins = []\n',
		})
		const configPath = resolve(fixture.path, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		writeLoaderHmrConfigV2(
			configPath,
			{
				version: 2,
				profile: 'hmr',
				defaults: { roots: 'auto' },
				profiles: { hmr: { enabled: ['pluxel-plugin-a', 'pluxel-plugin-b'] } },
			},
			{ headerComment: '', fs },
		)
		const res = await diagnoseLoaderHmrWorkspace({
			rootDir: fixture.path,
			configPath,
			env: {},
			omitPackages: ['pluxel-plugin-a'],
			fs,
		})
		expect(res.ok).toBe(true)
		if (res.ok !== true) return
		expect(res.snapshot.enabled).toEqual(['pluxel-plugin-b'])
		expect(res.snapshot.enabledEntries).toEqual(['plugins/b/src/index.ts'])
	})
})
