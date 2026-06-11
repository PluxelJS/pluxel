import {
	diagnoseLoaderHmrWorkspace,
	type LoaderHmrWorkspaceFs,
	type PluxelLoaderHmrConfigV1,
	readLoaderHmrConfigV1,
	writeLoaderHmrConfigV1,
} from '@pluxel/runtime-dynamic/hmr'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

describe('@pluxel/runtime-dynamic/hmr workspace profiles', () => {
	it('parses config strictly (unknown fields rejected)', async () => {
		await using fixture = await createFixture({
			'pluxel.loader.hmr.jsonc':
				'{ "version": 1, "profile": "hmr", "profiles": { "hmr": { "enabled": [] } }, "foo": 1 }',
		})
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		expect(() =>
			readLoaderHmrConfigV1(resolve(fixture.path, 'pluxel.loader.hmr.jsonc'), fs),
		).toThrow(/unknown|unexpected|foo/i)
	})

	it('returns a friendly error when config file is missing', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', "  - 'packages/*'", ''].join('\n'),
			'packages/a/package.json': JSON.stringify(
				{ name: 'pluxel-plugin-a', version: '0.0.0' },
				null,
				2,
			),
			'packages/a/src/index.ts': 'export const a = 1\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		const res = await diagnoseLoaderHmrWorkspace({ rootDir, configPath, env: {}, fs })
		expect(res.ok).toBe(false)
		if (res.ok !== false) return
		expect(res.errors[0]).toContain('Missing config file')
		expect(res.errors[0]).toContain('pluxel.loader.hmr.jsonc')
	})

	it('diagnoseLoaderHmrWorkspace resolves enabledEntries, include entries, and watchRoots', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', "  - 'packages/*'", ''].join('\n'),
			'packages/shared/package.json': JSON.stringify(
				{ name: 'pluxel-shared', version: '0.0.0' },
				null,
				2,
			),
			'packages/shared/src/index.ts': 'export const shared = 1\n',
			'packages/plugin-a/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-a',
					version: '0.0.0',
					type: 'module',
					dependencies: { 'pluxel-shared': 'workspace:*' },
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'packages/plugin-a/src/index.ts': 'export const pluginA = 1\n',
			'packages/plugin-builtin/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-builtin',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { import: './dist/index.mjs', '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'packages/plugin-builtin/src/index.ts': 'export const pluginBuiltin = 1\n',
			'packages/plugin-builtin/dist/index.mjs': 'export const pluginBuiltinDist = 1\n',
			'packages/plugins-host/package.json': JSON.stringify(
				{ name: '@pluxel/plugins-host', version: '0.0.0' },
				null,
				2,
			),
			'packages/plugins-host/src/demo/PluginEventsDemo.ts': 'export const demo = 1\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs

		const cfg: PluxelLoaderHmrConfigV1 = {
			version: 1,
			profile: 'hmr',
			defaults: {
				roots: 'auto',
				exclude: ['**/node_modules/**', '**/dist/**'],
			},
			profiles: {
				hmr: {
					enabled: ['pluxel-plugin-a'],
					builtin: ['pluxel-plugin-builtin'],
					include: ['packages/plugins-host/src/demo/**/*.ts'],
				},
			},
		}
		writeLoaderHmrConfigV1(configPath, cfg, { headerComment: '', fs })

		const res = await diagnoseLoaderHmrWorkspace({ rootDir, configPath, env: {}, fs })
		expect(res.ok).toBe(true)
		if (res.ok !== true) return

		expect(res.snapshot.activeProfile).toBe('hmr')
		expect(res.snapshot.enabled).toEqual(['pluxel-plugin-a'])
		expect(res.snapshot.builtinPackages).toEqual(['pluxel-plugin-builtin'])
		expect(res.snapshot.builtinsFromDist).toEqual([
			{ packageName: 'pluxel-plugin-builtin', entry: 'packages/plugin-builtin/dist/index.mjs' },
		])

		expect(res.snapshot.enabledEntries[0]).toBe('packages/plugin-a/src/index.ts')
		expect(res.snapshot.enabledEntries).toContain(
			'packages/plugins-host/src/demo/PluginEventsDemo.ts',
		)
		expect(res.snapshot.includedEntries).toEqual([
			'packages/plugins-host/src/demo/PluginEventsDemo.ts',
		])

		// watchRoots includes the enabled plugin package + its workspace deps closure + include-containing package
		expect(res.snapshot.watchRoots).toContain('packages/plugin-a')
		expect(res.snapshot.watchRoots).toContain('packages/shared')
		expect(res.snapshot.watchRoots).toContain('packages/plugins-host')

		expect(res.snapshot.includeGlobs.length).toBeGreaterThan(0)
		expect(res.snapshot.excludeGlobs).toEqual(['**/node_modules/**', '**/dist/**'])
	})

	it('supports omitPackages to prevent double-loading builtins', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - builtin-plugins/*', '  - chatbots/*', ''].join(
				'\n',
			),
			'builtin-plugins/graphql/package.json': JSON.stringify(
				{
					name: '@pluxel/graphql',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'builtin-plugins/graphql/src/index.ts': 'export const plugins = []\n',
			'chatbots/bot-suite/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-bot-suite',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'chatbots/bot-suite/src/index.ts': 'export const plugins = []\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		writeLoaderHmrConfigV1(
			configPath,
			{
				version: 1,
				profile: 'hmr',
				defaults: { roots: 'auto' },
				profiles: { hmr: { enabled: ['@pluxel/graphql', 'pluxel-plugin-bot-suite'] } },
			},
			{ headerComment: '', fs },
		)

		const res = await diagnoseLoaderHmrWorkspace({
			rootDir,
			configPath,
			env: {},
			omitPackages: ['@pluxel/graphql'],
			fs,
		})
		expect(res.ok).toBe(true)
		if (res.ok !== true) return

		expect(res.snapshot.enabled).toEqual(['pluxel-plugin-bot-suite'])
		expect(res.snapshot.enabledEntries).toEqual(['chatbots/bot-suite/src/index.ts'])
		expect(res.snapshot.watchRoots).toEqual(['chatbots/bot-suite'])
		expect(res.warnings.join('\n')).toMatch(/Skipped 1 enabled package/i)
	})

	it('warns when a selected workspace plugin depends on another unselected workspace plugin', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', "  - 'packages/*'", ''].join('\n'),
			'packages/provider/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-provider',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'packages/provider/src/index.ts': 'export const Provider = 1\n',
			'packages/consumer/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-consumer',
					version: '0.0.0',
					type: 'module',
					dependencies: { 'pluxel-plugin-provider': 'workspace:*' },
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'packages/consumer/src/index.ts': 'export const Consumer = 1\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		writeLoaderHmrConfigV1(
			configPath,
			{
				version: 1,
				profile: 'hmr',
				defaults: { roots: 'auto' },
				profiles: { hmr: { enabled: ['pluxel-plugin-consumer'] } },
			},
			{ headerComment: '', fs },
		)

		const res = await diagnoseLoaderHmrWorkspace({ rootDir, configPath, env: {}, fs })
		expect(res.ok).toBe(true)
		if (res.ok !== true) return

		expect(res.snapshot.enabledEntries).toEqual(['packages/consumer/src/index.ts'])
		expect(res.snapshot.watchRoots).toEqual(['packages/consumer', 'packages/provider'])
		expect(res.warnings.join('\n')).toContain(
			'Missing profile packages: pluxel-plugin-consumer -> pluxel-plugin-provider',
		)
	})

	it('fails fast when a builtin package exports no dist .mjs entry', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - builtin-plugins/*', '  - apps/*', ''].join('\n'),
			'builtin-plugins/graphql/package.json': JSON.stringify(
				{
					name: '@pluxel/graphql',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts', default: './dist/index.js' } },
				},
				null,
				2,
			),
			'builtin-plugins/graphql/src/index.ts': 'export const plugins = []\n',
			'builtin-plugins/graphql/dist/index.js': 'export default class GraphQL {}\n',
			'apps/app/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-app',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime-dynamic': './src/index.ts' } },
				},
				null,
				2,
			),
			'apps/app/src/index.ts': 'export const plugins = []\n',
		})

		const rootDir = fixture.path
		const configPath = resolve(rootDir, 'pluxel.loader.hmr.jsonc')
		const fs = fixture.fs as LoaderHmrWorkspaceFs
		writeLoaderHmrConfigV1(
			configPath,
			{
				version: 1,
				profile: 'hmr',
				defaults: { roots: 'auto' },
				profiles: { hmr: { enabled: ['pluxel-plugin-app'], builtin: ['@pluxel/graphql'] } },
			},
			{ headerComment: '', fs },
		)

		const res = await diagnoseLoaderHmrWorkspace({ rootDir, configPath, env: {}, fs })
		expect(res.ok).toBe(false)
		if (res.ok !== false) return
		expect(res.errors.join('\n')).toMatch(/missing dist \.mjs export entry/i)
	})
})
