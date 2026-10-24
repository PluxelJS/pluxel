import { describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'pathe'
import { pluginPackage, resolveBuildContext, type BuildRuntimeConfig } from '../src/cli'
import { runWithTsdown } from '../src/internal-cli'
import { runRules } from '../src/cli/rules'

const toolchainRequire = createRequire(import.meta.url)
const reactExportNames = Object.keys(toolchainRequire('react')).filter((name) => name !== 'default')

const pluginPackageOverlay = (context: BuildRuntimeConfig) =>
	pluginPackage({
		root: context.projectRoot,
		packageMetadata: {
			packageJsonPath: context.packageJsonPath,
			log: () => {},
		},
	})

function fixturePackage(name: string, version: string, exports: readonly string[]) {
	return {
		[`node_modules/${name}/package.json`]: JSON.stringify({
			name,
			version,
			type: 'module',
			exports: {
				...Object.fromEntries(
					exports.map((subpath) => [subpath, subpath === '.' ? './index.js' : `${subpath}.js`]),
				),
				'./package.json': './package.json',
			},
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
				devDependencies: {
					'pluxel-plugin-beta': '^0.5.0',
				},
				peerDependencies: {
					'pluxel-plugin-alpha': '^1.0.0',
					'pluxel-plugin-beta': '^0.5.0',
					'pluxel-plugin-stale': '^9.0.0',
				},
				peerDependenciesMeta: {
					'pluxel-plugin-beta': { optional: true },
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
			"import { writeFile } from 'node:fs/promises'",
			'export default {',
			"\tentry: 'src/index.ts',",
			"\tformat: ['esm', 'cjs'],",
			'\tdts: false,',
			'\tsourcemap: false,',
			'\tclean: true,',
			'\tdeps: { neverBundle: true },',
			"\tonSuccess: () => writeFile('user-success.txt', 'ok'),",
			'}',
			'',
		].join('\n'),
		'src/index.ts': [
			"import { BasePlugin, definePluginRef, Plugin, PluginPart } from '@pluxel/core'",
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
	runtimeUi: {
		...fixturePackage('react', '19.3.1', ['.', './jsx-runtime', './jsx-dev-runtime']),
		...fixturePackage('react-dom', '19.3.1', ['.', './client']),
		// Shared export analysis inspects the toolchain's real Bridge and its React imports.
		'node_modules/react/index.js': reactExportNames
			.map((name) => `export const ${name} = 'must-not-bundle-react-${name}'`)
			.join('\n'),
		'node_modules/react/index.d.ts': reactExportNames
			.map((name) => `export declare const ${name}: string`)
			.join('\n'),
		...fixturePackage('@mantine/core', '9.7.3', ['.']),
		...fixturePackage('@mantine/hooks', '9.7.3', ['.']),
		...fixturePackage('@pluxel/workbench', '0.1.0', [
			'.',
			'./client',
			'./react',
			'./internal/react',
		]),
		...fixturePackage('@pluxel/core', '1.0.0', ['.']),
		...fixturePackage('capnweb', '0.12.0', ['.']),
		'node_modules/@pluxel/core/index.js':
			'export class BasePlugin {}\nexport function Plugin() { return () => {} }\n',
		'node_modules/@pluxel/core/index.d.ts':
			'export declare class BasePlugin { ctx: any }\nexport declare function Plugin(input?: unknown): any\n',
		'node_modules/capnweb/index.js': 'export class RpcTarget {}\n',
		'node_modules/capnweb/index.d.ts':
			'export declare class RpcTarget { [Symbol.dispose](): void }\n',
		'node_modules/@pluxel/workbench/index.js': `
export const workbench = Object.freeze({
	entry: (_base, path) => ({ path }),
	view: (value) => value,
	tab: (value) => value,
	define: (value) => Object.freeze(value),
})
`,
		'node_modules/@pluxel/workbench/index.d.ts': `
export declare const workbench: {
	entry(base: string, path: string): Readonly<{ path: string }>
	view<Api>(value: Record<string, unknown>): unknown
	tab(value?: Record<string, unknown>): unknown
	define<const Entries extends Record<string, unknown>>(value: Entries): Readonly<Entries>
}
`,
		'node_modules/@pluxel/workbench/internal/react.js': `
export function createWorkbenchBridge(identity, Renderer) {
	return Object.freeze({ identity, Renderer })
}
`,
		'node_modules/@pluxel/workbench/internal/react.d.ts':
			'export declare function createWorkbenchBridge(identity: unknown, Renderer: unknown): unknown\n',
		'package.json': JSON.stringify(
			{
				name: 'pluxel-cli-build-fixture-runtime-ui',
				version: '1.0.0',
				type: 'module',
				dependencies: {
					'@mantine/core': '9.7.3',
					'@mantine/hooks': '9.7.3',
					'@pluxel/core': '1.0.0',
					'@pluxel/workbench': '0.1.0',
					react: '19.3.1',
					'react-dom': '19.3.1',
				},
				peerDependencies: { capnweb: '0.12.0' },
				devDependencies: { capnweb: '0.12.0' },
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
			"import { BasePlugin, Plugin } from '@pluxel/core'",
			"import { RpcTarget } from 'capnweb'",
			"import { workbench } from '@pluxel/workbench'",
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

describe('plugin package build', () => {
	it('composes compiler metadata, all-external overrides and user hooks without rewriting author fields', async () => {
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

			const pkg = JSON.parse(await readFile(runtime.packageJsonPath, 'utf8'))
			expect(pkg.optionalDependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(pkg.optionalDependencies?.['pluxel-plugin-beta']).toBeUndefined()
			expect(pkg.peerDependencies?.['pluxel-plugin-alpha']).toBe('^1.0.0')
			expect(pkg.peerDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(pkg.peerDependencies?.['pluxel-plugin-stale']).toBe('^9.0.0')
			expect(pkg.peerDependenciesMeta?.['pluxel-plugin-stale']?.optional).toBe(true)
			expect(pkg.dependencies?.['pluxel-plugin-alpha']).toBeUndefined()
			expect(pkg.devDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(pkg.peerDependenciesMeta?.['pluxel-plugin-beta']?.optional).toBe(true)
			expect(pkg.pluxel?.pluginPackages).toEqual({
				'pluxel-plugin-alpha': 'required',
				'pluxel-plugin-beta': 'optional',
			})

			expect(await readFile(resolve(fixtureDir, 'user-success.txt'), 'utf8')).toBe('ok')
			expect(await readFile(resolve(fixtureDir, 'dist/index.mjs'), 'utf8')).toMatch(
				/from ["']@pluxel\/core["']/,
			)

			const firstManifest = await readFile(runtime.packageJsonPath, 'utf8')
			// Writeback idempotence and removal belong to the manifest owner, not another compile.
			await runRules({
				packageJsonPath: runtime.packageJsonPath,
				pluginUsages: new Map([
					['pluxel-plugin-alpha', 'required'],
					['pluxel-plugin-beta', 'optional'],
				]),
			})
			expect(await readFile(runtime.packageJsonPath, 'utf8')).toBe(firstManifest)
			await runRules({ packageJsonPath: runtime.packageJsonPath, pluginUsages: new Map() })
			const cleaned = JSON.parse(await readFile(runtime.packageJsonPath, 'utf8'))
			expect(cleaned.peerDependencies?.['pluxel-plugin-alpha']).toBe('^1.0.0')
			expect(cleaned.peerDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(cleaned.peerDependenciesMeta?.['pluxel-plugin-beta']?.optional).toBe(true)
			expect(cleaned.devDependencies?.['pluxel-plugin-beta']).toBe('^0.5.0')
			expect(cleaned.pluxel?.pluginPackages).toBeUndefined()
		})
	})

	it('rejects an incorrect Plugin dependency role without writing any manifest field', async () => {
		await using fixture = await createFixture({
			'package.json': buildFixtures.basic['package.json'],
		})
		const packageJsonPath = resolve(fixture.path, 'package.json')
		const manifest = JSON.parse(buildFixtures.basic['package.json'])
		delete manifest.peerDependencies['pluxel-plugin-alpha']
		manifest.dependencies = { 'pluxel-plugin-alpha': '^1.0.0' }
		const original = JSON.stringify(manifest, null, 2)
		await writeFile(packageJsonPath, original)
		await expect(
			runRules({
				packageJsonPath,
				pluginUsages: new Map([['pluxel-plugin-alpha', 'required']]),
			}),
		).rejects.toThrow(/peerDependencies\.pluxel-plugin-alpha/)
		expect(await readFile(packageJsonPath, 'utf8')).toBe(original)
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
			expect(output).toContain('@pluxel/workbench')
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
		})
	}, 120_000)

	it.each([
		{
			config: "{ entry: 'src/index.ts', external: ['pluxel-plugin-alpha'] }",
			message: 'tsdown user override must use deps.* keys only; found deprecated keys: external',
		},
		{
			config: "[{ entry: 'src/index.ts' }]",
			message: 'tsdown override must export a single config object or async function',
		},
	])('rejects an invalid tsdown override: $config', async ({ config, message }) => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: 'invalid-plugin-build', type: 'module' }),
			'tsdown.config.ts': `export default ${config}`,
			'src/index.ts': 'export const answer = 1',
		})
		const cwd = process.cwd()
		try {
			process.chdir(fixture.path)
			const context = await resolveBuildContext({})
			await expect(runWithTsdown({ context, log: () => {} })).rejects.toThrow(message)
		} finally {
			process.chdir(cwd)
		}
	})

	it('rejects decorator syntax introduced by caller-supplied output plugins', async () => {
		await withBuildFixture('basic', async () => {
			const context = await resolveBuildContext({})
			await expect(
				runWithTsdown({
					context,
					log: () => {},
					extraConfig: pluginPackage({
						root: context.projectRoot,
						packageMetadata: { packageJsonPath: context.packageJsonPath, log: () => {} },
						additionalPlugins: [
							{
								name: 'fixture:invalid-output',
								generateBundle(_, bundle) {
									for (const item of Object.values(bundle)) {
										if (item.type === 'chunk') item.code += '\n@Plugin() class InvalidOutput {}'
									}
								},
							},
						],
					}),
				}),
			).rejects.toThrow('still contains decorator syntax')
		})
	})
})
