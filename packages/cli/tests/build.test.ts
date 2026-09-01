import { describe, expect, it, vi } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import {
	BuildEnvKeys,
	pluginPackage,
	resolveBuildContext,
	runWithTsdown,
	type BuildRuntimeConfig,
} from '@pluxel/rolldown/build'

const pluginPackageOverlay = (context: BuildRuntimeConfig) =>
	pluginPackage({
		root: context.projectRoot,
		packageMetadata: {
			packageJsonPath: context.packageJsonPath,
			manifestField: context.manifestField,
			log: () => {},
		},
	})

function fixturePackage(name: string, version: string, exports: readonly string[]) {
	return {
		[`node_modules/${name}/package.json`]: JSON.stringify({
			name,
			version,
			type: 'module',
			exports: Object.fromEntries(
				exports.map((subpath) => [subpath, subpath === '.' ? './index.js' : `${subpath}.js`]),
			),
		}),
		...Object.fromEntries(
			exports.map((subpath) => [
				`node_modules/${name}/${subpath === '.' ? 'index.js' : `${subpath.slice(2)}.js`}`,
				'export {}\n',
			]),
		),
	}
}

const buildFixtures = {
	basic: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture',
				version: '1.0.0',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
				dependencies: {
					'pluxel-plugin-alpha': '^1.0.0',
				},
				devDependencies: {
					'pluxel-plugin-beta': '^0.5.0',
				},
				peerDependencies: {
					'pluxel-plugin-stale': '^9.0.0',
				},
				peerDependenciesMeta: {
					'pluxel-plugin-stale': { optional: true },
				},
				optionalDependencies: {},
				pluxel: {
					pluginPackages: {
						'pluxel-plugin-stale': 'required',
						'pluxel-plugin-beta': 'optional',
					},
				},
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm', 'cjs'],",
			'\tdts: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { BasePlugin, definePluginRef, Plugin, PluginPart } from '@pluxel/runtime'",
			"import { AlphaPlugin } from 'pluxel-plugin-alpha'",
			"import type { AlphaPlugin as OptionalAlphaPlugin } from 'pluxel-plugin-alpha'",
			"import type { BetaPlugin } from 'pluxel-plugin-beta'",
			'',
			'const Alpha = definePluginRef<OptionalAlphaPlugin>()',
			'const Beta = definePluginRef<BetaPlugin>()',
			'class AlphaPart extends PluginPart<FixturePlugin> {',
			'  constructor(readonly alpha: AlphaPlugin) { super() }',
			'  init() { this.plugins.use(Alpha, () => undefined) }',
			'}',
			"@Plugin({ displayName: 'FixturePlugin' })",
			'export class FixturePlugin extends BasePlugin {',
			'  readonly first = this.parts.use(AlphaPart)',
			'  readonly second = this.parts.use(AlphaPart)',
			'  init() { this.plugins.use(Beta, () => undefined) }',
			'}',
			'',
		].join('\n'),
	},
	custom: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-custom',
				version: '1.0.0',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
				dependencies: {
					'acme-plugin-alpha': '1.2.3',
				},
				devDependencies: {
					'acme-plugin-beta': '~1.0.0',
				},
				peerDependencies: {
					'acme-plugin-beta': '~1.0.0',
				},
				optionalDependencies: {},
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'",
			"import { AlphaPlugin } from 'acme-plugin-alpha'",
			"import type { BetaPlugin } from 'acme-plugin-beta'",
			'',
			'const Beta = definePluginRef<BetaPlugin>()',
			"@Plugin({ displayName: 'CustomFixturePlugin' })",
			'export class CustomFixturePlugin extends BasePlugin {',
			'  constructor(readonly alpha: AlphaPlugin) { super() }',
			'  init() { this.plugins.use(Beta, () => undefined) }',
			'}',
			'',
		].join('\n'),
	},
	runtimeUi: {
		...fixturePackage('react', '19.2.8', ['.', './jsx-runtime', './jsx-dev-runtime']),
		...fixturePackage('react-dom', '19.2.8', ['.', './client']),
		...fixturePackage('@mantine/core', '9.5.2', ['.']),
		...fixturePackage('@mantine/hooks', '9.5.2', ['.']),
		...fixturePackage('@pluxel/runtime', '1.0.0', [
			'.',
			'./capnweb',
			'./internal/workbench-react',
			'./workbench',
			'./workbench/client',
			'./workbench/react',
		]),
		'node_modules/@pluxel/runtime/index.js':
			'export class BasePlugin {}\nexport function Plugin() { return () => {} }\n',
		'node_modules/@pluxel/runtime/index.d.ts':
			'export declare class BasePlugin { ctx: any }\nexport declare function Plugin(input?: unknown): any\n',
		'node_modules/@pluxel/runtime/capnweb.js': 'export class RpcTarget {}\n',
		'node_modules/@pluxel/runtime/capnweb.d.ts':
			'export declare class RpcTarget { [Symbol.dispose](): void }\n',
		'node_modules/@pluxel/runtime/workbench.js': `
export const workbench = Object.freeze({
	entry: (_base, path) => ({ path }),
	view: (value) => value,
	tab: (value) => value,
	define: (value) => Object.freeze(value),
})
`,
		'node_modules/@pluxel/runtime/workbench.d.ts': `
export declare const workbench: {
	entry(base: string, path: string): Readonly<{ path: string }>
	view<Api>(value: Record<string, unknown>): unknown
	tab(value?: Record<string, unknown>): unknown
	define<const Entries extends Record<string, unknown>>(value: Entries): Readonly<Entries>
}
`,
		'node_modules/@pluxel/runtime/internal/workbench-react.js': `
export function createWorkbenchBridge(identity, Renderer) {
	return Object.freeze({ identity, Renderer })
}
`,
		'node_modules/@pluxel/runtime/internal/workbench-react.d.ts':
			'export declare function createWorkbenchBridge(identity: unknown, Renderer: unknown): unknown\n',
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-runtime-ui',
				version: '1.0.0',
				type: 'module',
				dependencies: {
					'@mantine/core': '9.5.2',
					'@mantine/hooks': '9.5.2',
					'@pluxel/runtime': '1.0.0',
					react: '19.2.8',
					'react-dom': '19.2.8',
				},
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			},
			null,
			2,
		),
		'package-lock.json': JSON.stringify({ lockfileVersion: 3 }),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { BasePlugin, Plugin } from '@pluxel/runtime'",
			"import { RpcTarget } from '@pluxel/runtime/capnweb'",
			"import { workbench } from '@pluxel/runtime/workbench'",
			'',
			"const first = workbench.entry(import.meta.url, './ui/index.ts')",
			"const second = workbench.entry(import.meta.url, './ui/second.ts')",
			'export const DemoWorkbench = workbench.define({',
			'	first: workbench.view<any>({ renderer: first, placement: workbench.tab() }),',
			'	second: workbench.view<any>({ renderer: second, placement: workbench.tab() }),',
			'})',
			'',
			"@Plugin({ displayName: 'RuntimeUiFixturePlugin' })",
			'export class RuntimeUiFixturePlugin extends BasePlugin {',
			'\tinit() {',
			'\t\tthis.ctx.workbench.publish(DemoWorkbench, {',
			'\t\t\tfirst: () => new RpcTarget(),',
			'\t\t\tsecond: () => new RpcTarget(),',
			'\t\t})',
			'\t}',
			'}',
		].join('\n'),
		'src/ui/index.ts': [
			"export const UI_ONLY_MARKER = '__PLUXEL_UI_ONLY_MARKER__'",
			'export default function First() { return UI_ONLY_MARKER }',
			'',
		].join('\n'),
		'src/ui/second.ts': [
			"export const SECOND_UI_ONLY_MARKER = '__PLUXEL_SECOND_UI_ONLY_MARKER__'",
			'export default function Second() { return SECOND_UI_ONLY_MARKER }',
			'',
		].join('\n'),
	},
	decoratedPlugin: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-decorated-plugin',
				version: '1.0.0',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			'\tminify: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'\tinputOptions(options) {',
			'\t\treturn {',
			'\t\t\t...options,',
			'\t\t\ttransform: {',
			'\t\t\t\t...options.transform,',
			'\t\t\t\tdefine: { ...options.transform?.define, __FIXTURE_INPUT__: JSON.stringify("preserved") },',
			'\t\t\t},',
			'\t\t}',
			'\t},',
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { BasePlugin, Plugin } from '@pluxel/runtime'",
			'declare const __FIXTURE_INPUT__: string',
			'export const inputOverride = __FIXTURE_INPUT__',
			'',
			"@Plugin({ displayName: 'FixtureProvider' })",
			'export class FixtureProvider extends BasePlugin {}',
			'',
			"@Plugin({ displayName: 'FixtureConsumer' })",
			'export class FixtureConsumer extends BasePlugin {',
			'\tconstructor(readonly provider: FixtureProvider) {',
			'\t\tsuper()',
			'\t}',
			'}',
			'',
		].join('\n'),
	},
	deprecatedTsdownKeys: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-deprecated-keys',
				version: '1.0.0',
				type: 'module',
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm'],",
			'\tdts: false,',
			"\texternal: ['pluxel-plugin-alpha'],",
			'\tsourcemap: false,',
			'\tclean: true,',
			'}',
			'',
		].join('\n'),
		'src/index.ts': ['export const answer = 1', ''].join('\n'),
	},
	arrayTsdownConfig: {
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-array-config',
				version: '1.0.0',
				type: 'module',
			},
			null,
			2,
		),
		'tsconfig.json': JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2020',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: false,
					declaration: false,
					allowSyntheticDefaultImports: true,
					esModuleInterop: true,
				},
				include: ['src'],
			},
			null,
			2,
		),
		'tsdown.config.ts': [
			'export default [',
			'\t{',
			"\t\tentry: 'src/index.ts',",
			"\t\tformat: ['esm'],",
			'\t\tdts: false,',
			'\t\tsourcemap: false,',
			'\t\tclean: true,',
			'\t},',
			']',
			'',
		].join('\n'),
		'src/index.ts': ['export const answer = 2', ''].join('\n'),
	},
} satisfies Record<string, Record<string, string>>

async function withBuildFixture<T>(
	name: keyof typeof buildFixtures,
	run: (dir: string) => Promise<T>,
) {
	await using fixture = await createFixture(buildFixtures[name])
	const originalCwd = process.cwd()
	try {
		process.chdir(fixture.path)
		return await run(fixture.path)
	} finally {
		process.chdir(originalCwd)
	}
}

describe('build command', () => {
	it('dedupes repeated Part requirements and keeps required metadata over optional use', async () => {
		await withBuildFixture('basic', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})
			expect(runtime.projectRoot).toBe(fixtureDir)
			expect(runtime.packageJsonPath).toBe(resolve(fixtureDir, 'package.json'))
			await runWithTsdown({
				context: runtime,
				log: () => {},
				extraConfig: pluginPackageOverlay(runtime),
			})
			expect(
				await stat(resolve(fixtureDir, '.pluxel/workbench-build')).catch((): null => null),
			).toBeNull()

			const pkg = await readPackageJSON(runtime.packageJsonPath)
			expect(pkg.optionalDependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(pkg.optionalDependencies?.['pluxel-plugin-beta']).toBeUndefined()
			expect(pkg.peerDependencies?.['pluxel-plugin-alpha']).toBe('^1.0.0')
			expect(pkg.peerDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(pkg.peerDependencies?.['pluxel-plugin-stale']).toBeUndefined()
			expect(pkg.peerDependenciesMeta?.['pluxel-plugin-stale']).toBeUndefined()
			expect(pkg.dependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(pkg.devDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(pkg.peerDependenciesMeta?.['pluxel-plugin-beta']?.optional).toBe(true)
			expect(pkg.pluxel?.pluginPackages).toEqual({
				'pluxel-plugin-alpha': 'required',
				'pluxel-plugin-beta': 'optional',
			})

			const firstManifest = await readFile(runtime.packageJsonPath, 'utf8')
			await runWithTsdown({
				context: runtime,
				log: () => {},
				extraConfig: pluginPackageOverlay(runtime),
			})
			expect(await readFile(runtime.packageJsonPath, 'utf8')).toBe(firstManifest)

			await writeFile(
				resolve(fixtureDir, 'src/index.ts'),
				[
					"import { BasePlugin, Plugin } from '@pluxel/runtime'",
					"@Plugin({ displayName: 'FixturePlugin' })",
					'export class FixturePlugin extends BasePlugin {}',
				].join('\n'),
			)
			await runWithTsdown({
				context: runtime,
				log: () => {},
				extraConfig: pluginPackageOverlay(runtime),
			})
			const cleaned = await readPackageJSON(runtime.packageJsonPath)
			expect(cleaned.peerDependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(cleaned.peerDependencies?.['pluxel-plugin-beta']).toBeUndefined()
			expect(cleaned.peerDependenciesMeta?.['pluxel-plugin-beta']).toBeUndefined()
			expect(cleaned.devDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(cleaned.pluxel?.pluginPackages).toBeUndefined()
		})
	})

	it('composes preset metadata and user success hooks', async () => {
		await withBuildFixture('basic', async (fixtureDir) => {
			await writeFile(
				resolve(fixtureDir, 'tsdown.config.ts'),
				[
					"import { writeFile } from 'node:fs/promises'",
					'export default {',
					"  entry: 'src/index.ts',",
					"  format: ['esm', 'cjs'],",
					'  dts: false,',
					"  onSuccess: () => writeFile('user-success.txt', 'ok'),",
					'}',
				].join('\n'),
			)
			const runtime = await resolveBuildContext({})
			await runWithTsdown({
				context: runtime,
				log: () => {},
				extraConfig: pluginPackageOverlay(runtime),
			})
			const pkg = await readPackageJSON(runtime.packageJsonPath)
			expect(pkg.pluxel?.pluginPackages).toEqual({
				'pluxel-plugin-alpha': 'required',
				'pluxel-plugin-beta': 'optional',
			})
			expect(await readFile(resolve(fixtureDir, 'user-success.txt'), 'utf8')).toBe('ok')
		})
	})

	it('preserves an all-external tsdown override when merging the plugin preset', async () => {
		await withBuildFixture('basic', async (fixtureDir) => {
			await writeFile(
				resolve(fixtureDir, 'tsdown.config.ts'),
				[
					'export default {',
					"  entry: 'src/index.ts',",
					"  format: ['esm'],",
					'  dts: false,',
					'  deps: { neverBundle: true },',
					'}',
				].join('\n'),
			)
			const runtime = await resolveBuildContext({})

			await runWithTsdown({
				context: runtime,
				log: () => {},
				extraConfig: pluginPackageOverlay(runtime),
			})

			expect(await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf8')).toMatch(
				/from ["']@pluxel\/runtime["']/,
			)
		})
	})

	it('respects custom manifest field config', async () => {
		try {
			await withBuildFixture('custom', async (_fixtureDir) => {
				vi.stubEnv(BuildEnvKeys.manifestField, 'customField')

				const runtime = await resolveBuildContext({})
				await runWithTsdown({
					context: runtime,
					log: () => {},
					extraConfig: pluginPackageOverlay(runtime),
				})

				const pkg = await readPackageJSON(runtime.packageJsonPath)
				expect(pkg.optionalDependencies?.['acme-plugin-alpha']).toBeUndefined()
				expect(pkg.optionalDependencies?.['acme-plugin-beta']).toBeUndefined()
				expect(pkg.peerDependencies?.['acme-plugin-alpha']).toBe('1.2.3')
				expect(pkg.peerDependencies?.['acme-plugin-beta']).toBe('~1.0.0')
				expect(pkg.dependencies?.['acme-plugin-alpha']).toBeUndefined()
				expect(pkg.devDependencies?.['acme-plugin-beta']).toBe('~1.0.0')
				expect(pkg.peerDependenciesMeta?.['acme-plugin-beta']?.optional).toBe(true)
				expect(pkg.customField?.pluginPackages).toEqual({
					'acme-plugin-alpha': 'required',
					'acme-plugin-beta': 'optional',
				})
			})
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('fills repository metadata from supported CI providers', async () => {
		for (const provider of [
			{
				env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'pluxel/example' },
				baseUrl: 'https://github.com/pluxel/example',
				issues: '/issues',
			},
			{
				env: { GITLAB_CI: 'true', CI_PROJECT_PATH: 'pluxel/example', CI_SERVER_HOST: 'gitlab.com' },
				baseUrl: 'https://gitlab.com/pluxel/example',
				issues: '/-/issues',
			},
		]) {
			try {
				await withBuildFixture('basic', async () => {
					for (const [key, value] of Object.entries(provider.env)) vi.stubEnv(key, value)
					const runtime = await resolveBuildContext({})
					await runWithTsdown({
						context: runtime,
						log: () => {},
						extraConfig: pluginPackageOverlay(runtime),
					})
					const pkg = await readPackageJSON(runtime.packageJsonPath)
					expect(pkg.repository).toEqual({ type: 'git', url: `${provider.baseUrl}.git` })
					expect(pkg.homepage).toBe(provider.baseUrl)
					expect(pkg.bugs).toEqual({ url: `${provider.baseUrl}${provider.issues}` })
				})
			} finally {
				vi.unstubAllEnvs()
			}
		}
	})

	it('lowers one direct Workbench definition into one multi-expose MF producer', async () => {
		await withBuildFixture('runtimeUi', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})

			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: pluginPackageOverlay,
			})

			const output = await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf-8')
			expect(output).toContain('this.ctx.workbench.publish')
			expect(output).toContain('@pluxel/runtime/workbench')
			expect(output).not.toContain('.bind(')
			expect(output).not.toContain('__PLUXEL_UI_ONLY_MARKER__')
			expect(output).not.toContain('__PLUXEL_SECOND_UI_ONLY_MARKER__')
			const workbenchRoot = resolve(fixtureDir, 'dist/workbench')
			const inventory = JSON.parse(
				await readFile(resolve(workbenchRoot, 'pluxel-workbench-producers.json'), 'utf-8'),
			) as {
				producers: readonly {
					artifactRoot: string
					plan: { producer: string; buildRevision: string; entries: readonly unknown[] }
				}[]
			}
			expect(inventory.producers).toHaveLength(1)
			expect(inventory.producers[0]?.plan.producer).toMatch(/^pluxel_workbench_[a-f0-9]{32}$/)
			expect(inventory.producers[0]?.plan.entries).toHaveLength(2)
			const firstProducer = inventory.producers[0]!
			const files = await readdir(workbenchRoot, { recursive: true })
			expect(files.filter((file) => String(file).endsWith('mf-manifest.json'))).toHaveLength(1)
			expect(files.filter((file) => String(file).endsWith('remoteEntry.js'))).toHaveLength(1)
			expect(files.some((file) => String(file).endsWith('.map'))).toBe(false)
			const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
			const uiOutput = await Promise.all(
				jsFiles.map((file) => readFile(resolve(workbenchRoot, file), 'utf-8')),
			)
			expect(uiOutput.join('\n')).toContain('__PLUXEL_UI_ONLY_MARKER__')
			expect(uiOutput.join('\n')).toContain('__PLUXEL_SECOND_UI_ONLY_MARKER__')

			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: pluginPackageOverlay,
			})

			expect(await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf-8')).not.toContain(
				'__PLUXEL_UI_ONLY_MARKER__',
			)
			const repeatedInventory = JSON.parse(
				await readFile(resolve(workbenchRoot, 'pluxel-workbench-producers.json'), 'utf-8'),
			) as typeof inventory
			expect(repeatedInventory.producers).toEqual([firstProducer])
			const repeatedManifest = await stat(
				resolve(fixtureDir, 'dist', firstProducer.artifactRoot, 'mf-manifest.json'),
			)
			expect(repeatedManifest.isFile()).toBe(true)

			await writeFile(
				resolve(fixtureDir, 'src/ui/index.ts'),
				[
					"export const UI_ONLY_MARKER = '__PLUXEL_UI_ONLY_MARKER_V2__'",
					'export default function First() { return UI_ONLY_MARKER }',
					'',
				].join('\n'),
			)
			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: pluginPackageOverlay,
			})
			const invalidatedInventory = JSON.parse(
				await readFile(resolve(workbenchRoot, 'pluxel-workbench-producers.json'), 'utf-8'),
			) as typeof inventory
			const invalidatedProducer = invalidatedInventory.producers[0]!
			expect(invalidatedProducer.plan.producer).toBe(firstProducer.plan.producer)
			expect(invalidatedProducer.plan.buildRevision).not.toBe(firstProducer.plan.buildRevision)
			expect(invalidatedProducer.artifactRoot).not.toBe(firstProducer.artifactRoot)
			const invalidatedManifest = await stat(
				resolve(fixtureDir, 'dist', invalidatedProducer.artifactRoot, 'mf-manifest.json'),
			)
			expect(invalidatedManifest.isFile()).toBe(true)
		})
	}, 120_000)

	it('lowers plugin definitions and required dependency facts without reflection metadata', async () => {
		await withBuildFixture('decoratedPlugin', async (fixtureDir) => {
			const runtime = await resolveBuildContext({})
			await runWithTsdown({
				context: runtime,
				onSuccess: async () => {},
				log: () => {},
				extraConfig: pluginPackageOverlay,
			})

			const output = await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf-8')
			expect(output).not.toMatch(/@Plugin\b/)
			expect(output).not.toContain('design:paramtypes')
			expect(output).toContain('FixtureProvider')
			expect(output).toContain('FixtureConsumer')
			expect(output).toContain('preserved')
		})
	})

	it('rejects deprecated tsdown dependency keys in plugin overrides', async () => {
		await withBuildFixture('deprecatedTsdownKeys', async () => {
			const runtime = await resolveBuildContext({})

			await expect(
				runWithTsdown({
					context: runtime,
					onSuccess: async () => {},
					log: () => {},
				}),
			).rejects.toThrow(
				'tsdown user override must use deps.* keys only; found deprecated keys: external',
			)
		})
	})

	it('rejects tsdown override arrays to keep plugin build semantics singular', async () => {
		await withBuildFixture('arrayTsdownConfig', async () => {
			const runtime = await resolveBuildContext({})

			await expect(
				runWithTsdown({
					context: runtime,
					onSuccess: async () => {},
					log: () => {},
				}),
			).rejects.toThrow('tsdown override must export a single config object or async function')
		})
	})
})
