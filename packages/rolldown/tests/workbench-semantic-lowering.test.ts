import { readFile, symlink, writeFile } from 'node:fs/promises'
import { parsePluginDefinitionAddress } from '@pluxel/core'
import { workbenchFederationBuildOutDir } from '@pluxel/core/federation'
import { createFixture } from 'fs-fixture'
import { dirname, resolve } from 'pathe'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { createPluginSemanticsPlugin } from '../src/rolldown/plugins/pluginSemanticsPlugin'
import { pluginArtifactBuildPlugin } from '../src/plugin-artifact/pluginArtifactBuildPlugin'
import { parseStandaloneWithLang } from '../src/rolldown/plugins/pluginUtils'
import { buildWorkbenchFederationProducer } from '../src/vite/workbench-ui'
import { validateWorkbenchFederationArtifact } from '../src/workbench/artifact'
import { resolveWorkbenchFederationShared } from '../src/workbench/build-contract'
import { createWorkbenchSemanticLowering } from '../src/workbench/semantic-lowering'

const owner = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/semantic-plugin' },
	exportName: 'SemanticPlugin',
})

function packageFiles(name: string, version: string, exports: readonly string[]) {
	const packageExports = Object.fromEntries(
		exports.map((subpath) => [subpath, subpath === '.' ? './index.js' : `${subpath}.js`]),
	)
	return {
		[`node_modules/${name}/package.json`]: JSON.stringify({
			name,
			version,
			type: 'module',
			exports: packageExports,
		}),
		...Object.fromEntries(
			exports.map((subpath) => [
				`node_modules/${name}/${subpath === '.' ? 'index.js' : `${subpath.slice(2)}.js`}`,
				'export {}\n',
			]),
		),
	}
}

function fixtureFiles(): Record<string, string> {
	return {
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': JSON.stringify({
			name: '@example/semantic-plugin',
			type: 'module',
			devDependencies: {
				'@mantine/core': '9.5.2',
				'@mantine/hooks': '9.5.2',
				'@pluxel/runtime': '1.0.0',
				react: '19.2.8',
				'react-dom': '19.2.8',
			},
		}),
		'tsconfig.json': JSON.stringify({
			compilerOptions: {
				allowJs: true,
				allowImportingTsExtensions: true,
				declaration: true,
				jsx: 'react-jsx',
				lib: ['ES2024', 'DOM', 'DOM.Iterable'],
				module: 'ESNext',
				moduleResolution: 'Bundler',
				strict: false,
				target: 'ES2022',
			},
			include: ['src', '.pluxel/workbench-generated'],
		}),
		'src/settings.tsx': 'export default function Settings() { return null }\n',
		'src/picker.tsx': 'export default function Picker() { return null }\n',
		...packageFiles('react', '19.2.8', ['.', './jsx-runtime', './jsx-dev-runtime']),
		...packageFiles('react-dom', '19.2.8', ['.', './client']),
		...packageFiles('@mantine/core', '9.5.2', ['.']),
		...packageFiles('@mantine/hooks', '9.5.2', ['.']),
		...packageFiles('@pluxel/runtime', '1.0.0', [
			'.',
			'./capnweb',
			'./internal/workbench-react',
			'./workbench',
			'./workbench/client',
			'./workbench/react',
		]),
		'node_modules/@pluxel/runtime/capnweb.d.ts': `
export interface RpcTarget extends Disposable {}
`,
		'node_modules/@pluxel/runtime/workbench.js': `
export const workbench = Object.freeze({
	entry: (_base, path) => ({ path }),
	view: (value) => value,
	attachment: (value) => Object.assign(value, { place: (placement) => ({ placement }) }),
	tab: (value) => value,
	define: (value) => Object.freeze(value),
})
`,
		'node_modules/@pluxel/runtime/workbench.d.ts': `
export type RendererEntry = Readonly<{ path: string }>
export type Entry<Api> = Readonly<{ renderer: RendererEntry; api?: Api }>
export type Attachment<Api> = Entry<Api> & { place(placement: unknown): unknown }
export declare const workbench: {
	entry(base: string, path: string): RendererEntry
	view<Api>(value: Entry<Api> & Record<string, unknown>): Entry<Api>
	attachment<Api>(value: Entry<Api> & Record<string, unknown>): Attachment<Api>
	tab(value: Record<string, unknown>): unknown
	define<const Entries extends Record<string, unknown>>(value: Entries): Readonly<Entries>
}
`,
		'node_modules/@pluxel/runtime/internal/workbench-react.js': `
export function createWorkbenchBridge(identity, descriptor, Renderer) {
	return Object.freeze({ identity, descriptor, Renderer })
}
`,
		'node_modules/@pluxel/runtime/internal/workbench-react.d.ts': `
export declare function createWorkbenchBridge(
	identity: unknown,
	descriptor: unknown,
	Renderer: unknown,
): unknown
`,
	}
}

async function collectModule(
	lowering: ReturnType<typeof createWorkbenchSemanticLowering>,
	root: string,
	file: string,
	code: string,
) {
	const id = resolve(root, file)
	await writeFile(id, code, 'utf-8')
	const ast = parseStandaloneWithLang(code, id)
	if (!ast) throw new Error(`failed to parse ${file}`)
	await lowering.collect({
		id,
		code,
		ast,
		owners: [{ className: 'SemanticPlugin', definition: owner }],
		resolve: async (source) => (source.startsWith('.') ? resolve(dirname(id), source) : undefined),
	})
}

describe('Workbench semantic lowering', () => {
	it('lowers one owner producer and generates exact descriptor-bound Bridge entries', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const code = `
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

interface SettingsApi extends RpcTarget {
	snapshot(): { enabled: boolean }
}
interface PickerApi extends RpcTarget {
	select(id: string): Promise<void>
}

const renderer = workbench.entry(import.meta.url, './settings.tsx')
function entries(viewRenderer: ReturnType<typeof workbench.entry>) {
	return {
		settings: workbench.view<SettingsApi>({
			renderer: viewRenderer,
			placement: workbench.tab({ label: 'Settings' }),
		}),
		picker: workbench.attachment<PickerApi>({
			renderer: workbench.entry(import.meta.url, './picker.tsx'),
		}),
	}
}
export const SemanticWorkbench = workbench.define(entries(renderer))

class SemanticPlugin {
	declare ctx: { workbench?: { publish(definition: unknown, bindings: unknown): void } }
	init() {
		this.ctx.workbench?.publish(SemanticWorkbench, { settings: () => ({}), picker: () => ({}) })
	}
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		const plans = await lowering.plans()

		expect(plans).toHaveLength(1)
		expect(plans[0]).toMatchObject({
			definition: owner,
			buildRevision: expect.stringMatching(/^[a-f0-9]{24}$/),
			entries: [
				{ descriptor: { kind: 'attachment', owner, key: 'picker' }, expose: './views/picker' },
				{ descriptor: { kind: 'view', owner, key: 'settings' }, expose: './views/settings' },
			],
		})
		const settings = plans[0]!.entries.find((entry) => entry.descriptor.key === 'settings')!
		const generated = await readFile(resolve(fixture.path, settings.bridgeEntryPath), 'utf-8')
		expect(generated).toContain(
			`createWorkbenchBridge(${JSON.stringify(settings.descriptor)}, Definition.settings, Renderer)`,
		)
		expect(generated).toContain('import { SemanticWorkbench as Definition }')
		expect(generated).toContain("from '@pluxel/runtime/internal/workbench-react'")

		const outDir = resolve(fixture.path, 'dist/semantic-producer')
		await buildWorkbenchFederationProducer({
			root: fixture.path,
			plan: plans[0]!,
			outDir,
			minify: false,
			packageMode: 'development',
		})
		const compatibility = resolveWorkbenchFederationShared(fixture.path).compatibility
		const validation = await validateWorkbenchFederationArtifact(outDir, {
			plan: plans[0]!,
			compatibility,
		})
		expect(validation.valid).toBe(true)
		if (validation.valid === false) throw new Error(validation.reason)
		expect(validation.manifest.shared).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: '@pluxel/runtime/workbench',
					version: '1.0.0',
					requiredVersion: '1.0.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/runtime/internal/workbench-react',
					version: '1.0.0',
					requiredVersion: '1.0.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/runtime/workbench/react',
					version: '1.0.0',
					requiredVersion: '1.0.0',
					singleton: true,
				}),
			]),
		)
	}, 60_000)

	it('builds a workspace producer from its package root into the host deployment root', async () => {
		const files = fixtureFiles()
		files['packages/nested/package.json'] = JSON.stringify({
			name: '@example/nested-plugin',
			type: 'module',
			devDependencies: {
				'@pluxel/runtime': '1.0.0',
				react: '19.2.8',
				'react-dom': '19.2.8',
			},
		})
		files['packages/nested/tsconfig.json'] = JSON.stringify({
			extends: '../../tsconfig.json',
			include: ['src', '.pluxel/workbench-generated'],
		})
		files['packages/shared/src/label.ts'] = "export const settingsLabel = 'Workspace settings'\n"
		files['packages/nested/src/settings.tsx'] = `
import { settingsLabel } from '../../shared/src/label.ts'
export default function Settings() { return settingsLabel }
`
		await using fixture = await createFixture(files)
		await symlink(
			resolve(fixture.path, 'node_modules'),
			resolve(fixture.path, 'packages/nested/node_modules'),
			'dir',
		)
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
})
class SemanticPlugin {
	declare ctx: { workbench: { publish(definition: unknown, bindings: unknown): void } }
	init() { this.ctx.workbench.publish(SemanticWorkbench, { settings: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'packages/nested/src/plugin.ts', code)
		const [compilation] = await lowering.compilations()
		const nestedRoot = resolve(fixture.path, 'packages/nested')

		expect(compilation?.root).toBe(nestedRoot)
		const bridgeEntryPath = compilation?.plan.entries[0]?.bridgeEntryPath
		expect(bridgeEntryPath).toMatch(/^\.pluxel\/workbench-generated\//)
		await expect(readFile(resolve(nestedRoot, bridgeEntryPath!), 'utf-8')).resolves.toContain(
			'../../../../src/plugin.ts',
		)

		const artifactPlugin = pluginArtifactBuildPlugin({
			root: fixture.path,
			buildDir: 'host-dist',
			workbench: { compilations: async () => [compilation!] },
		})
		const writeBundle = artifactPlugin.writeBundle as (() => Promise<void>) | undefined
		await writeBundle?.call({})

		const deploymentOutDir = resolve(
			fixture.path,
			workbenchFederationBuildOutDir(compilation!.plan, 'host-dist'),
		)
		const validation = await validateWorkbenchFederationArtifact(deploymentOutDir, {
			plan: compilation!.plan,
			compatibility: resolveWorkbenchFederationShared(fixture.path).compatibility,
		})
		expect(validation.valid).toBe(true)
		expect(deploymentOutDir.startsWith(resolve(fixture.path, 'host-dist'))).toBe(true)
	}, 60_000)

	it('does not create a producer for an attachment-only consumer', async () => {
		const files = fixtureFiles()
		files['src/provider.ts'] = `
import { workbench } from '@pluxel/runtime/workbench'
export const ProviderWorkbench = workbench.define({
	picker: workbench.attachment({ renderer: workbench.entry(import.meta.url, './picker.tsx') }),
})
`
		files['src/provider-index.ts'] = `export * from './provider.ts'\n`
		await using fixture = await createFixture(files)
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
import { ProviderWorkbench } from './provider-index.ts'
export const SemanticWorkbench = workbench.define({
	fonts: ProviderWorkbench.picker.place(workbench.tab({ label: 'Fonts' })),
})
class SemanticPlugin {
	init() {
		this.ctx.workbench.publish(SemanticWorkbench, { fonts: { provider: this.provider } })
	}
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		await expect(lowering.plans()).resolves.toEqual([])
	})

	it('atomically replaces repeated module collection while preserving cross-module ownership', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	settings: workbench.view({ renderer: workbench.entry(import.meta.url, './settings.tsx') }),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench, { settings: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await Promise.all([
			collectModule(lowering, fixture.path, 'src/plugin.ts', code),
			collectModule(lowering, fixture.path, 'src/plugin.ts', code),
		])
		await expect(lowering.plans()).resolves.toHaveLength(1)

		await collectModule(
			lowering,
			fixture.path,
			'src/plugin.ts',
			'class SemanticPlugin { init() {} }\n',
		)
		await expect(lowering.plans()).resolves.toEqual([])

		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		await expect(collectModule(lowering, fixture.path, 'src/other.ts', code)).rejects.toThrow(
			'duplicate Workbench publication ownership',
		)
	})

	it('rejects conditional publication and inline definition topology', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		const conditional = `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	settings: workbench.view({ renderer: workbench.entry(import.meta.url, './settings.tsx'), placement: workbench.tab() }),
})
class SemanticPlugin { init() { if (this.enabled) this.ctx.workbench.publish(SemanticWorkbench, {}) } }
`
		await expect(
			collectModule(lowering, fixture.path, 'src/conditional.ts', conditional),
		).rejects.toThrow('one unconditional statement in init()')

		lowering.reset()
		const inline = `
import { workbench } from '@pluxel/runtime/workbench'
class SemanticPlugin {
	init() { this.ctx.workbench.publish(workbench.define({}), {}) }
}
`
		await collectModule(lowering, fixture.path, 'src/inline.ts', inline)
		await expect(lowering.plans()).rejects.toThrow(
			'publish() first argument must be a statically traceable final workbench.define() binding',
		)
	})

	it('rejects publication from a helper or PluginPart instead of the owning Plugin', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({})
class CapabilityPart {
	init() { this.ctx.workbench.publish(SemanticWorkbench, {}) }
}
class SemanticPlugin {}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await expect(collectModule(lowering, fixture.path, 'src/plugin-part.ts', code)).rejects.toThrow(
			'only the owning @Plugin class may publish',
		)
	})

	it('binds plans to canonical owners discovered by the Plugin semantic pass', async () => {
		const files = fixtureFiles()
		files['src/plugin.ts'] = `
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab(),
	}),
})
@Plugin()
export class SemanticPlugin extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(SemanticWorkbench, { settings: () => ({}) })
	}
}
`
		await using fixture = await createFixture(files)
		const collector = createPluginSemanticsPlugin({ root: fixture.path })
		const bundle = await rolldown({
			input: resolve(fixture.path, 'src/plugin.ts'),
			external: ['@pluxel/runtime', '@pluxel/runtime/toolchain', '@pluxel/runtime/workbench'],
			plugins: [collector.plugin],
		})
		await bundle.generate({ format: 'esm' })
		await bundle.close()

		const plugin = collector.definitions().find((item) => item.className === 'SemanticPlugin')
		const plans = await collector.workbenchPlans()
		expect(plugin?.definition).toEqual({
			entry: { kind: 'source-entry', sourceSpace: 'app', path: 'src/plugin.ts' },
			exportName: 'SemanticPlugin',
		})
		expect(plans).toHaveLength(1)
		expect(plans[0]?.definition).toEqual(plugin?.definition)
	})

	it('derives build revision from the exact definition and renderer source graph', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const source = (label: string) => `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: ${JSON.stringify(label)} }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench, { settings: () => ({}) }) }
}
`
		const first = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(first, fixture.path, 'src/plugin.ts', source('Settings'))
		const firstPlans = await first.plans()
		const firstRevision = firstPlans[0]!.buildRevision

		const definitionChanged = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(definitionChanged, fixture.path, 'src/plugin.ts', source('Configuration'))
		const definitionPlans = await definitionChanged.plans()
		const definitionRevision = definitionPlans[0]!.buildRevision
		expect(definitionRevision).not.toBe(firstRevision)

		await writeFile(
			resolve(fixture.path, 'src/settings.tsx'),
			'export default function Settings() { return "changed" }\n',
		)
		const rendererChanged = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(rendererChanged, fixture.path, 'src/plugin.ts', source('Configuration'))
		const rendererPlans = await rendererChanged.plans()
		const rendererRevision = rendererPlans[0]!.buildRevision
		expect(rendererRevision).not.toBe(definitionRevision)
	})
})
