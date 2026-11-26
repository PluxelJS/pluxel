import { execFileSync } from 'node:child_process'
import { readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parsePluginDefinitionAddress, pluginDefinitionIndexKey } from '@pluxel/core'
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
import {
	publishWorkbenchContentArtifact,
	writeWorkbenchContentDeploymentInventory,
} from '../src/workbench/content-artifact'

const testRequire = createRequire(import.meta.url)
const reactExportNames = Object.keys(testRequire('react')).filter((name) => name !== 'default')
const typescriptBin = resolve(dirname(testRequire.resolve('typescript/package.json')), 'bin/tsc')

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
				'@mantine/core': '9.7.4',
				'@mantine/hooks': '9.7.4',
				'@pluxel/workbench': '0.1.0',
				react: '19.3.0',
				'react-dom': '19.3.0',
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
				rewriteRelativeImportExtensions: true,
				strict: false,
				target: 'ES2022',
			},
			include: ['src', '.pluxel/workbench-generated'],
		}),
		'src/settings.tsx': 'export default function Settings() { return null }\n',
		'src/picker.tsx': 'export default function Picker() { return null }\n',
		'src/tool.tsx': 'export default function Tool() { return null }\n',
		...packageFiles('react', '19.3.0', ['.', './jsx-runtime', './jsx-dev-runtime']),
		...packageFiles('react-dom', '19.3.0', ['.', './client']),
		// Shared export analysis also visits the toolchain's real Bridge implementation.
		'node_modules/react/index.js': reactExportNames
			.map((name) => `export const ${name} = 'must-not-bundle-react-${name}'`)
			.join('\n'),
		'node_modules/react/index.d.ts': reactExportNames
			.map((name) => `export declare const ${name}: string`)
			.join('\n'),
		...packageFiles('@mantine/core', '9.7.4', ['.']),
		...packageFiles('@mantine/hooks', '9.7.4', ['.']),
		...packageFiles('@pluxel/core', '1.1.0', ['.']),
		'node_modules/@pluxel/core/index.js': `
export function defineServiceRef() { throw new Error('Service ref was not lowered') }
`,
		'node_modules/@pluxel/core/index.d.ts': `
declare const serviceRef: unique symbol
export interface ServiceRef<T> { readonly [serviceRef]: (service: T) => T }
export declare function defineServiceRef<T>(): ServiceRef<T>
`,
		...packageFiles('@pluxel/workbench', '0.1.0', [
			'.',
			'./internal/react',
			'./client',
			'./react',
			'./mantine',
		]),
		...packageFiles('capnweb', '0.4.0', ['.']),
		'node_modules/capnweb/index.d.ts': `
export interface RpcTarget extends Disposable {}
`,
		'node_modules/@pluxel/workbench/index.js': `
export class Workbench { static access = 'owner' }
export const workbench = Object.freeze({
	view: (value) => value,
	content: (value) => value,
	attachment: (value) => Object.assign(value, { place: (placement) => ({ placement }) }),
	data: (schema) => ({ schema }),
	action: (value) => value,
	define: (_base, value) => Object.freeze(value),
})
`,
		'node_modules/@pluxel/workbench/index.d.ts': `
export declare class Workbench {
	static readonly access: 'owner'
	publish<Definition>(definition: Definition, bindings?: unknown): { link(key: keyof Definition, params?: Record<string, string>): unknown }
}
declare const apiType: unique symbol
declare const consumerApiType: unique symbol
declare const owner: unique symbol
export type Owned<Entry = unknown> = Entry & { readonly [owner]: true }
export type Definition<Entries> = { readonly [K in keyof Entries]: Owned<Entries[K]> }
type DescriptorBrand<Api, ConsumerApi = never> = Readonly<{
	[apiType]: (value: Api) => Api
	[consumerApiType]: (value: ConsumerApi) => ConsumerApi
}>
export type Entry<Api> = Readonly<{ renderer: string }> & DescriptorBrand<Api>
export type Attachment<Api, ConsumerApi = never> = Entry<Api> &
	DescriptorBrand<Api, ConsumerApi> & { place(placement: unknown): unknown }
export type WorkbenchRenderableDescriptor = Readonly<{ renderer: string }>
export type WorkbenchDescriptorApi<Descriptor> = Descriptor extends Readonly<{
	[apiType]: (value: infer Api) => unknown
}> ? Api : never
export type WorkbenchDescriptorConsumerApi<Descriptor> = Descriptor extends Readonly<{
	[consumerApiType]: (value: infer Api) => unknown
}> ? Api : never
export declare const workbench: {
	view<Api>(value: Readonly<{ renderer: string }> & Record<string, unknown>): Entry<Api>
	content(value: Record<string, unknown>): unknown
	attachment<Api, ConsumerApi = never>(
		value: Readonly<{ renderer: string }> & Record<string, unknown>,
	): Attachment<Api, ConsumerApi>
	data(schema: unknown): unknown
	action(value: Record<string, unknown>): unknown
	define<const Entries extends Record<string, unknown>>(
		base: string,
		value: Entries & { [K in keyof Entries]: Entries[K] extends Owned ? never : Entries[K] },
	): Definition<Entries>
}
`,
		'node_modules/@pluxel/workbench/react.js': `
export function createWorkbenchRenderer() {
	return Object.freeze({
		render: (Component) => Component,
		useWorkbench: () => Object.freeze({ api: Object.freeze({}) }),
	})
}
`,
		'node_modules/@pluxel/workbench/react.d.ts': `
import type {
	WorkbenchDescriptorApi,
	WorkbenchDescriptorConsumerApi,
	WorkbenchRenderableDescriptor,
} from './index.js'
type WorkbenchHookValue<Descriptor> = [WorkbenchDescriptorConsumerApi<Descriptor>] extends [never]
	? { api: WorkbenchDescriptorApi<Descriptor> }
	: {
		api: WorkbenchDescriptorApi<Descriptor>
		provider: WorkbenchDescriptorApi<Descriptor>
		consumer: WorkbenchDescriptorConsumerApi<Descriptor>
	}
export declare function createWorkbenchRenderer<Descriptor extends WorkbenchRenderableDescriptor>(
	descriptor: Descriptor,
): {
	render<Component>(component: Component): Component
	useWorkbench(): WorkbenchHookValue<Descriptor>
}
`,
		'node_modules/@pluxel/workbench/internal/react.js': `
export function createWorkbenchBridge(identity, Renderer) {
	return Object.freeze({ identity, Renderer })
}
`,
		'node_modules/@pluxel/workbench/internal/react.d.ts': `
export declare function createWorkbenchBridge(
	identity: unknown,
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
	it('projects a resolved panel placement while leaving Content independent of the producer', async () => {
		const files = fixtureFiles()
		files['src/guide.md'] = '# Plugin panel guide\n'
		files['src/settings.tsx'] = `
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { SemanticWorkbench } from './plugin.ts'
const renderer = createWorkbenchRenderer(SemanticWorkbench.settings)
export default renderer.render(function Settings() { return null })
`
		files['src/provider.ts'] = `
import { workbench } from '@pluxel/workbench'
export const ProviderWorkbench = workbench.define(import.meta.url, {
	picker: workbench.attachment({ renderer: './picker.tsx' }),
})
`
		await using fixture = await createFixture(files)
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
import { ProviderWorkbench } from './provider.ts'
const region = 'bottom'
const options = { label: 'Plugin status', icon: 'settings', order: -12 }
function placement(region, options) { return { kind: 'panel', region, ...options } }
export const SemanticWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({ renderer: './settings.tsx', placement: placement(region, options) }),
	guide: workbench.content({ document: './guide.md', placement: { kind: 'panel', region: 'left', label: 'Guide' } }),
	fonts: ProviderWorkbench.picker.place({ kind: 'panel', region: 'bottom', label: 'Fonts' }),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { settings: () => ({}), fonts: { provider: this.provider } }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		const plans = await lowering.plans()
		expect(plans).toHaveLength(1)
		expect(plans[0]!.entries.map((entry) => entry.descriptor.key)).toEqual(['settings'])
		const generatedDir = dirname(resolve(fixture.path, plans[0]!.entries[0]!.bridgeEntryPath))
		const projection = await readFile(resolve(generatedDir, 'settings.definition.ts'), 'utf-8')
		expect(projection).toContain(
			JSON.stringify({
				kind: 'panel',
				region: 'bottom',
				label: 'Plugin status',
				icon: 'settings',
				order: -12,
			}),
		)
		expect(await lowering.contentCompilations()).toHaveLength(1)
	})

	it.each([
		["{ kind: 'panel', region: 'center', label: 'Tool' }", 'region must be left, right, or bottom'],
		["{ kind: 'panel', region: 'left', label: '' }", 'label'],
		[
			"{ kind: 'panel', region: 'right', label: 'Tool', icon: 'arbitrary-icon' }",
			'fixed Workbench icon set',
		],
		["{ kind: 'panel', region: 'bottom', label: 'Tool', scope: 'global' }", 'unsupported option'],
	])('rejects invalid static panel declaration %s', async (placement, error) => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/panel-validation', type: 'module' }),
			'src/guide.md': '# Guide\n',
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({ document: './guide.md', placement: ${placement} }),
})
class SemanticPlugin { init() { this.ctx.service(Workbench).publish(SemanticWorkbench) } }
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		await expect(lowering.contentCompilations()).rejects.toThrow(error)
	})

	it('compiles Markdown-only Content without creating or resolving an MF producer', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/content-only', type: 'module' }),
			'src/guide.md': [
				'# Operations',
				'',
				'See [Operations](#Operations), [运维说明](#运维说明), and [support](mailto:ops@example.com).',
				'',
				'## 运维说明',
				'',
				'| State | Ready |',
				'| :-- | --: |',
				'| Cache | Yes |',
				'',
				'```sh',
				'pluxel status',
				'```',
			].join('\n'),
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		placement: { kind: 'tab', label: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)

		await expect(lowering.plans()).resolves.toEqual([])
		const content = await lowering.contentCompilations()
		expect(content).toHaveLength(1)
		expect(content[0]).toMatchObject({
			digest: expect.stringMatching(/^[a-f\d]{64}$/),
			root: fixture.path,
			contentSet: {
				version: 1,
				kind: 'workbench-content-set',
				definition: owner,
				entries: [{ key: 'guide', content: { version: 1, kind: 'workbench-content', slots: [] } }],
			},
		})
		const blocks = content[0]!.contentSet.entries[0]!.content.document.blocks
		expect(blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'heading', anchor: 'operations' }),
				expect.objectContaining({ type: 'table' }),
				expect.objectContaining({ type: 'code', language: 'sh', value: 'pluxel status' }),
			]),
		)
		expect(blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'heading', anchor: 'section' }),
				expect.objectContaining({
					type: 'paragraph',
					children: expect.arrayContaining([
						expect.objectContaining({ target: { kind: 'fragment', anchor: 'operations' } }),
						expect.objectContaining({ target: { kind: 'fragment', anchor: 'section' } }),
					]),
				}),
			]),
		)
		const initialDigest = content[0]!.digest
		await writeFile(resolve(fixture.path, 'src/guide.md'), '# Updated operations\n')
		lowering.invalidate()
		const [updatedContent] = await lowering.contentCompilations()
		expect(updatedContent?.digest).not.toBe(initialDigest)
		await expect(
			readFile(resolve(fixture.path, '.pluxel/workbench-generated/missing'), 'utf-8'),
		).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('resolves contributed document paths from the final definition and slots from their declaring module', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/composed-content', type: 'module' }),
			'src/guide.md': '# Diagnostics\n\n::slot[status]\n',
			'src/shared/entries.ts': `
import { workbench } from '@pluxel/workbench'
const Status = {}
const options = { document: './guide.md', slots: { status: workbench.data(Status) }, placement: { kind: 'tab' } }
export const guide = workbench.content(options)
`,
		})
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(
			lowering,
			fixture.path,
			'src/plugin.ts',
			`
import { Workbench, workbench } from '@pluxel/workbench'
import { guide } from './shared/entries.ts'
export const Pages = workbench.define(import.meta.url, { guide })
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(Pages, { guide: () => ({}) }) }
}
`,
		)
		const [compilation] = await lowering.contentCompilations()
		expect(compilation!.contentSet.entries[0]!.content.slots).toMatchObject([
			{ key: 'status', kind: 'data' },
		])
	})

	it('rejects unsafe or unsupported Markdown at the build boundary', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/content-invalid', type: 'module' }),
			'src/guide.md': '# Guide\n\n<script>alert(1)</script>\n',
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		placement: { kind: 'route', path: '/guide', title: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		await expect(lowering.contentCompilations()).rejects.toThrow('raw HTML and MDX')
	})

	it('lowers data and action slots without evaluating or serializing their schema bindings', async () => {
		const schemaSentinel = 'CONTENT_SCHEMA_MUST_STAY_SERVER_ONLY_7f31'
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/interactive-content', type: 'module' }),
			'src/guide.md': [
				'# Service',
				'',
				'Endpoint: :slot[status]',
				'',
				'::slot[probe]',
				'',
				'::slot[dialog]',
				'',
				'::slot[clear]',
			].join('\n'),
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
const StatusSchema = { marker: '${schemaSentinel}' }
const ProbeSchema = { marker: '${schemaSentinel}' }
const slots = {
	status: workbench.data(StatusSchema),
	probe: workbench.action({ label: 'Probe', input: ProbeSchema, form: 'embedded' }),
	dialog: workbench.action({ label: 'Dialog', input: ProbeSchema }),
clear: workbench.action({ label: 'Clear', confirm: 'Deletes cached state' }),
}
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md', slots,
		placement: { kind: 'tab', label: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { guide: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)

		await expect(lowering.plans()).resolves.toEqual([])
		const [compilation] = await lowering.contentCompilations()
		const content = compilation!.contentSet.entries[0]!.content
		expect(content.slots).toEqual([
			{
				kind: 'action',
				key: 'clear',
				display: 'block',
				label: 'Clear',
				input: 'none',
				confirm: 'Deletes cached state',
			},
			{
				kind: 'action',
				key: 'dialog',
				display: 'block',
				label: 'Dialog',
				input: 'dialog',
			},
			{
				kind: 'action',
				key: 'probe',
				display: 'block',
				label: 'Probe',
				input: 'embedded',
			},
			{ kind: 'data', key: 'status', display: 'inline' },
		])
		expect(content.document.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'slot', key: 'probe' }),
				expect.objectContaining({ type: 'slot', key: 'dialog' }),
				expect.objectContaining({ type: 'slot', key: 'clear' }),
				expect.objectContaining({
					type: 'paragraph',
					children: expect.arrayContaining([
						expect.objectContaining({ type: 'slot', key: 'status' }),
					]),
				}),
			]),
		)
		expect(new TextDecoder().decode(compilation!.bytes)).not.toContain(schemaSentinel)
	})

	it.each([
		{
			name: 'unknown slots',
			markdown: '::slot[other]\n',
			slot: 'workbench.data(StatusSchema)',
			error: 'slot other is undeclared',
		},
		{
			name: 'missing slots',
			markdown: '# Guide\n',
			slot: 'workbench.data(StatusSchema)',
			error: 'slot status must appear exactly once',
		},
		{
			name: 'duplicate slots',
			markdown: '::slot[status]\n\n::slot[status]\n',
			slot: 'workbench.data(StatusSchema)',
			error: 'slot status must appear exactly once',
		},
		{
			name: 'inline actions',
			markdown: 'Run :slot[status]\n',
			slot: "workbench.action({ label: 'Run' })",
			error: 'action slot status must be block-level',
		},
		{
			name: 'nested slots',
			markdown: '> :slot[status]\n',
			slot: 'workbench.data(StatusSchema)',
			error: 'slots cannot be nested',
		},
		{
			name: 'slot attributes',
			markdown: '::slot[status]{unexpected=yes}\n',
			slot: 'workbench.data(StatusSchema)',
			error: 'slots do not accept attributes',
		},
		{
			name: 'other directives',
			markdown: '::other[status]\n',
			slot: 'workbench.data(StatusSchema)',
			error: 'directive other is not supported',
		},
	])('rejects $name at the Markdown boundary', async ({ markdown, slot, error }) => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/invalid-content-slot', type: 'module' }),
			'src/guide.md': markdown,
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
const StatusSchema = {}
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md', slots: { status: ${slot} },
		placement: { kind: 'tab', label: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { guide: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		await expect(lowering.contentCompilations()).rejects.toThrow(error)
	})

	it('rejects non-binding schemas and non-exact slot records during semantic lowering', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/dynamic-content-slot', type: 'module' }),
			'src/guide.md': '::slot[status]\n',
		})
		const compile = async (slots: string) => {
			const code = `
import { Workbench, workbench } from '@pluxel/workbench'
const StatusSchema = {}
const inherited = { inherited: workbench.data(StatusSchema) }
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md', slots: ${slots},
		placement: { kind: 'tab', label: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { guide: () => ({}) }) }
}
`
			const lowering = createWorkbenchSemanticLowering(fixture.path)
			await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
			return lowering.contentCompilations()
		}
		await expect(compile('{ status: workbench.data(makeSchema()) }')).rejects.toThrow(
			'schema must be a module-level binding',
		)
		await expect(compile('{ ...inherited, status: workbench.data(StatusSchema) }')).rejects.toThrow(
			'slot map requires exact static properties',
		)
		await expect(compile('undefined')).rejects.toThrow(
			'slot map binding undefined is not traceable',
		)
		await expect(
			compile('{ status: workbench.data(StatusSchema), status: workbench.data(StatusSchema) }'),
		).rejects.toThrow('slot map property status is duplicated')
	})

	it('rejects leading frontmatter before CommonMark can reinterpret it as content', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/content-frontmatter', type: 'module' }),
			'src/guide.md': '---\ntitle: Guide\n---\n\n# Guide\n',
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		placement: { kind: 'tab', label: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		await expect(lowering.contentCompilations()).rejects.toThrow(
			'1:1: frontmatter is not supported',
		)
	})

	it('reuses an exact packaged Content artifact when distribution source has no Markdown', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/packaged-content', type: 'module' }),
			'src/guide.md': '# Packaged guide\n',
		})
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		placement: { kind: 'tab', label: 'Guide' },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench) }
}
`
		const source = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(source, fixture.path, 'src/plugin.ts', code)
		const [compiled] = await source.contentCompilations()
		const entry = await publishWorkbenchContentArtifact(fixture.path, 'dist', compiled!)
		await writeWorkbenchContentDeploymentInventory(fixture.path, 'dist', [entry])
		await rm(resolve(fixture.path, 'src/guide.md'))

		const packaged = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(packaged, fixture.path, 'src/plugin.ts', code)
		const [reused] = await packaged.contentCompilations()
		expect(reused?.digest).toBe(compiled?.digest)
		expect(reused?.contentSet).toEqual(compiled?.contentSet)
		expect(reused?.sources).toEqual([])
	})

	it('builds relocated type assets for mixed renderer imports without executing server code', async () => {
		await using fixture = await createFixture(fixtureFiles())
		await writeFile(
			resolve(fixture.path, 'src/settings.tsx'),
			`import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { type SettingsChange as Change, SemanticWorkbench as Editor, type SettingsApi } from './plugin.ts'
export type EditorChange = Change
const settings = createWorkbenchRenderer(Editor.settings)
export default settings.render(function Settings() {
	const { api } = settings.useWorkbench()
	const state: ReturnType<SettingsApi['snapshot']> = api.snapshot()
	const edit: Change = { enabled: state.enabled }
	// @ts-expect-error Change must retain the author's exact property type
	const invalid: Change = { enabled: 'yes' }
	// @ts-expect-error the browser projection must retain the exact View API
	api.select('not-a-settings-method')
	return null
})
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/picker.tsx'),
			`import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { SemanticWorkbench, type SettingsChange } from './plugin.ts'
export type PickerChange = SettingsChange
const picker = createWorkbenchRenderer(SemanticWorkbench.picker)
export default picker.render(function Picker() {
	const { provider, consumer } = picker.useWorkbench()
	provider.select('selected')
	consumer.preview('selected')
	// @ts-expect-error provider and consumer contracts must not collapse to any
	provider.preview('not-a-provider-method')
	return null
})
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/protocol.ts'),
			`import type { RpcTarget } from 'capnweb'
export interface SettingsApi extends RpcTarget {
	snapshot(): { enabled: boolean }
}
export type PickerApi = RpcTarget & {
	select(id: string): Promise<void>
}
export interface PickerConsumerApi extends RpcTarget {
	preview(id: string): void
}
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/protocol-index.ts'),
			`export type { PickerApi, PickerConsumerApi, SettingsApi } from './protocol.ts'\n`,
			'utf-8',
		)
		const code = `
import { defineServiceRef } from '@pluxel/core'

import { workbench } from '@pluxel/workbench'
import type { PickerApi, PickerConsumerApi, SettingsApi } from './protocol-index.ts'
import type { Workbench } from '@pluxel/workbench'
export type { SettingsApi } from './protocol-index.ts'
export interface SettingsChange { enabled: boolean }
if (typeof window !== 'undefined') throw new Error('MIXED_IMPORT_SERVER_CODE_ONLY')
const WorkbenchRef = defineServiceRef<Workbench>()

const renderer = './settings.tsx'
function entries(viewRenderer: string) {
	return {
		settings: workbench.view<SettingsApi>({
			renderer: viewRenderer,
			placement: { kind: 'tab', label: 'Settings' },
		}),
		picker: workbench.attachment<PickerApi, PickerConsumerApi>({
			renderer: './picker.tsx',
		}),
	}
}
export const SemanticWorkbench = workbench.define(import.meta.url, entries(renderer))

class SemanticPlugin {
	declare ctx: { service(ref: ReturnType<typeof defineServiceRef<Workbench>>): Workbench | undefined }
	init() {
		this.ctx.service(WorkbenchRef)?.publish(SemanticWorkbench, {
			settings: () => ({}),
			picker: () => ({}),
		})
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
		const outDir = resolve(fixture.path, 'dist/semantic-producer')
		await buildWorkbenchFederationProducer({
			root: fixture.path,
			plan: plans[0]!,
			outDir,
			minify: false,
			packageMode: 'distribution',
			typeAssets: 'required',
		})
		const artifactEntries = await readdir(outDir, { recursive: true })
		const artifactFiles = artifactEntries.map(String)
		const browserCode = await Promise.all(
			artifactFiles
				.filter((file) => /\.(m?js|map)$/.test(file) && !file.endsWith('.d.ts.map'))
				.map((file) => readFile(resolve(outDir, file), 'utf-8')),
		)
		expect(browserCode.join('\n')).not.toContain('MIXED_IMPORT_SERVER_CODE_ONLY')
		const declarations = await Promise.all(
			artifactFiles
				.filter((file) => file.endsWith('.d.ts'))
				.map((file) => readFile(resolve(outDir, file), 'utf-8')),
		)
		expect(declarations).not.toHaveLength(0)
		expect(declarations.join('\n')).not.toContain(fixture.path)
		expect(declarations.join('\n')).not.toContain('src/plugin.ts')
		const settingsDeclaration = artifactFiles.find((file) =>
			file.endsWith('/settings.definition.d.ts'),
		)
		expect(settingsDeclaration).toBeTypeOf('string')
		const settingsDeclarationPath = resolve(outDir, settingsDeclaration!)
		const rendererDeclaration = artifactFiles.find((file) =>
			file.endsWith('/settings.renderer.d.ts'),
		)
		expect(rendererDeclaration).toBeTypeOf('string')
		const rendererDeclarationPath = resolve(outDir, rendererDeclaration!)
		const rendererTypes = await readFile(rendererDeclarationPath, 'utf-8')
		expect(rendererTypes).toContain('SettingsChange as Change')
		expect(rendererTypes).toContain('EditorChange = Change')
		await rm(resolve(fixture.path, 'src'), { recursive: true, force: true })
		try {
			execFileSync(
				process.execPath,
				[
					typescriptBin,
					'--ignoreConfig',
					'--noEmit',
					'--pretty',
					'false',
					'--module',
					'ESNext',
					'--moduleResolution',
					'Bundler',
					'--target',
					'ES2022',
					'--lib',
					'ES2024,DOM,DOM.Iterable,ESNext.Disposable',
					settingsDeclarationPath,
					rendererDeclarationPath,
				],
				{ cwd: fixture.path, stdio: 'pipe' },
			)
		} catch (error) {
			const output = error as { stdout?: Buffer; stderr?: Buffer }
			throw new Error(
				`packaged Workbench declaration did not resolve:\n${output.stdout?.toString() ?? ''}${output.stderr?.toString() ?? ''}`,
				{ cause: error },
			)
		}
		const compatibility = resolveWorkbenchFederationShared(fixture.path).compatibility
		const validation = await validateWorkbenchFederationArtifact(outDir, {
			plan: plans[0]!,
			compatibility,
		})
		if (validation.valid === false) throw new Error(validation.reason)
		expect(validation.manifest.shared).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: '@pluxel/workbench',
					version: '0.1.0',
					requiredVersion: '0.1.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/workbench/internal/react',
					version: '0.1.0',
					requiredVersion: '0.1.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/workbench/react',
					version: '0.1.0',
					requiredVersion: '0.1.0',
					singleton: true,
				}),
			]),
		)
	}, 60_000)

	it('projects one exact renderer scope through every importing page without executing the definition', async () => {
		const serverSentinel = 'SCOPE_SERVER_DEFINITION_MUST_NOT_EXECUTE_97ac'
		const files = fixtureFiles()
		files['src/server-label.ts'] = `
if (typeof window !== 'undefined') throw new Error('${serverSentinel}')
export const serverLabel = 'Settings'
`
		files['src/settings.types.ts'] = `
import type { ScopedWorkbench } from './workbench.ts'
export type SettingsDescriptor = typeof ScopedWorkbench.settings
`
		files['src/settings.scope.ts'] = `
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import type { SettingsDescriptor } from './settings.types.ts'
import { ScopedWorkbench } from './workbench.ts'
export type SettingsScopeDescriptor = SettingsDescriptor
export const settingsRenderer = createWorkbenchRenderer(ScopedWorkbench.settings)
`
		files['src/settings-page.tsx'] = `
import { settingsRenderer } from './settings.scope.ts'
export function SettingsPage() {
	const { api } = settingsRenderer.useWorkbench()
	api.snapshot()
	return 'scope-page-marker'
}
`
		files['src/settings.tsx'] = `
import { SettingsPage } from './settings-page.tsx'
import { settingsRenderer } from './settings.scope.ts'
export default settingsRenderer.render(SettingsPage)
`
		await using fixture = await createFixture(files)
		const code = `
import type { RpcTarget } from 'capnweb'
import { Workbench, workbench } from '@pluxel/workbench'
import { serverLabel } from './server-label.ts'
interface SettingsApi extends RpcTarget { snapshot(): { enabled: boolean } }
export const ScopedWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view<SettingsApi>({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: serverLabel },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(ScopedWorkbench, { settings: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/workbench.ts', code)
		const [plan] = await lowering.plans()
		const outDir = resolve(fixture.path, 'dist/scoped-producer')
		await buildWorkbenchFederationProducer({
			root: fixture.path,
			plan: plan!,
			outDir,
			minify: false,
			sourcemap: true,
			packageMode: 'development',
			typeAssets: 'optional',
		})
		const browserFiles = await readdir(outDir, { recursive: true })
		const browserAssets = await Promise.all(
			browserFiles
				.map(String)
				.filter((file) => file.endsWith('.js') || file.endsWith('.map'))
				.map((file) => readFile(resolve(outDir, file), 'utf-8')),
		)
		expect(browserAssets.join('\n')).toContain('scope-page-marker')
		expect(browserAssets.join('\n')).not.toContain(serverSentinel)
	}, 60_000)

	it('rejects a renderer scope that does not bind its generated descriptor', async () => {
		const files = fixtureFiles()
		files['src/settings.scope.ts'] = `
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { ScopedWorkbench } from './workbench.ts'
export const settingsRenderer = createWorkbenchRenderer(ScopedWorkbench.other)
`
		files['src/settings.tsx'] = `
import { settingsRenderer } from './settings.scope.ts'
export default settingsRenderer.render(() => null)
`
		await using fixture = await createFixture(files)
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const ScopedWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: 'Settings' },
	}),
	other: workbench.view({
		renderer: './picker.tsx',
		placement: { kind: 'tab', label: 'Other' },
	}),
})
class SemanticPlugin {
	init() {
		this.ctx.service(Workbench).publish(ScopedWorkbench, { settings: () => ({}), other: () => ({}) })
	}
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/workbench.ts', code)
		await expect(lowering.plans()).rejects.toThrow(
			'one createWorkbenchRenderer() bound to ScopedWorkbench.settings',
		)
	})

	it('rejects a namespace renderer factory bound to the wrong descriptor', async () => {
		const files = fixtureFiles()
		files['src/settings.tsx'] = `
import * as WorkbenchReact from '@pluxel/workbench/react'
import { ScopedWorkbench } from './workbench.ts'
const settingsRenderer = WorkbenchReact.createWorkbenchRenderer(ScopedWorkbench.other)
export default settingsRenderer.render(() => null)
`
		await using fixture = await createFixture(files)
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const ScopedWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: 'Settings' },
	}),
	other: workbench.view({
		renderer: './picker.tsx',
		placement: { kind: 'tab', label: 'Other' },
	}),
})
class SemanticPlugin {
	init() {
		this.ctx.service(Workbench).publish(ScopedWorkbench, { settings: () => ({}), other: () => ({}) })
	}
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/workbench.ts', code)
		await expect(lowering.plans()).rejects.toThrow(
			'one createWorkbenchRenderer() bound to ScopedWorkbench.settings',
		)
	})

	it('keeps mixed Content schema and handler modules out of browser producer outputs', async () => {
		const schemaSentinel = 'SERVER_ONLY_CONTENT_SCHEMA_51d0a1'
		const handlerSentinel = 'SERVER_ONLY_CONTENT_HANDLER_b99c42'
		const files = fixtureFiles()
		files['src/guide.md'] = '::slot[status]\n\n::slot[probe]\n'
		files['src/settings.tsx'] = `
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { MixedWorkbench } from './mixed'
const settings = createWorkbenchRenderer(MixedWorkbench.settings)
export default settings.render(function Settings() { return null })
`
		files['src/content-schema.ts'] = `
export const schemaSentinel = '${schemaSentinel}'
export const StatusSchema = { marker: schemaSentinel }
export const ProbeSchema = { marker: schemaSentinel }
`
		files['src/content-handler.ts'] = `
export const handlerSentinel = '${handlerSentinel}'
export function probe() { return handlerSentinel }
`
		await using fixture = await createFixture(files)
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
import { StatusSchema, ProbeSchema } from './content-schema'
import { probe } from './content-handler'

export const MixedWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		slots: {
			status: workbench.data(StatusSchema),
			probe: workbench.action({ label: 'Probe', input: ProbeSchema }),
		},
		placement: { kind: 'tab', label: 'Guide' },
	}),
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: 'Settings' },
	}),
})
class SemanticPlugin {
	declare ctx: { service(definition: typeof Workbench): Workbench }
	init() {
		this.ctx.service(Workbench).publish(MixedWorkbench, {
			guide: () => ({ load: () => ({ status: {} }), actions: { probe } }),
			settings: () => ({}),
		})
	}
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/mixed.ts', code)
		const [plan] = await lowering.plans()
		const outDir = resolve(fixture.path, 'dist/mixed-producer')
		await buildWorkbenchFederationProducer({
			root: fixture.path,
			plan: plan!,
			outDir,
			minify: false,
			sourcemap: true,
			packageMode: 'development',
		})

		const leaked: string[] = []
		for (const name of await readdir(outDir, { recursive: true })) {
			const path = resolve(outDir, name)
			const stats = await stat(path)
			if (!stats.isFile()) continue
			const body = await readFile(path)
			if (
				body.includes(Buffer.from(schemaSentinel)) ||
				body.includes(Buffer.from(handlerSentinel))
			) {
				leaked.push(name)
			}
		}
		expect(leaked).toEqual([])
	}, 60_000)

	it.each([
		{
			name: 'an extra runtime value beside inline types and the bound definition',
			settings: `
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { type Shape, MixedWorkbench as Definition, serverOnly } from './mixed'
const scope = createWorkbenchRenderer(Definition.settings)
export default scope.render(() => serverOnly)
`,
			helper: undefined,
			expectedError: /only MixedWorkbench as a runtime value.*settings\.tsx/,
		},
		{
			name: 'a dynamic definition import',
			settings: `
export default async function Settings() {
	const { MixedWorkbench } = await import('./mixed')
	return MixedWorkbench.settings
}
			`,
			helper: undefined,
			expectedError:
				/src\/settings\.tsx[\s\S]*dynamic import[\s\S]*"\.\/mixed"[\s\S]*createWorkbenchRenderer\(MixedWorkbench\.settings\)/,
		},
		{
			name: 'a directly imported definition without a renderer scope',
			settings: `
import { MixedWorkbench } from './mixed'
export default function Settings() { return MixedWorkbench.settings }
`,
			helper: undefined,
			expectedError:
				/src\/settings\.tsx[\s\S]*"\.\/mixed"[\s\S]*requires one createWorkbenchRenderer\(\) bound to MixedWorkbench\.settings/,
		},
		{
			name: 'an indirect definition import',
			settings: `
import { descriptor } from './settings-helper'
export default function Settings() { return descriptor }
`,
			helper: `
import { MixedWorkbench } from './mixed'
export const descriptor = MixedWorkbench.settings
			`,
			expectedError:
				/src\/settings-helper\.ts[\s\S]*"\.\/mixed"[\s\S]*requires one createWorkbenchRenderer[\s\S]*createWorkbenchRenderer\(MixedWorkbench\.settings\)/,
		},
		{
			name: 'multiple server-definition boundaries',
			settings: `
import { first } from './settings-helper-a'
import { second } from './settings-helper-b'
export default function Settings() { return first ?? second }
`,
			helper: undefined,
			extraFiles: {
				'src/settings-helper-a.ts': `
import { MixedWorkbench } from './mixed'
export const first = MixedWorkbench.settings
`,
				'src/settings-helper-b.ts': `
import { MixedWorkbench } from './mixed'
export const second = MixedWorkbench.settings
`,
			},
			expectedError:
				/exactly one direct server definition import[\s\S]*settings-helper-a\.ts[\s\S]*settings-helper-b\.ts[\s\S]*createWorkbenchRenderer\(MixedWorkbench\.settings\)/,
		},
	])(
		'rejects $name from a renderer graph',
		async ({ settings, helper, extraFiles, expectedError }) => {
			const files = fixtureFiles()
			files['src/guide.md'] = '# Guide\n'
			files['src/settings.tsx'] = settings
			if (helper) files['src/settings-helper.ts'] = helper
			if (extraFiles) Object.assign(files, extraFiles)
			await using fixture = await createFixture(files)
			const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export type Shape = { title: string }
export const serverOnly: Shape = { title: 'Server-only state' }
export const MixedWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		placement: { kind: 'tab', label: 'Guide' },
	}),
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: 'Settings' },
	}),
})
class SemanticPlugin {
	declare ctx: { service(definition: typeof Workbench): Workbench }
	init() { this.ctx.service(Workbench).publish(MixedWorkbench, { guide: () => ({}), settings: () => ({}) }) }
}
`
			const lowering = createWorkbenchSemanticLowering(fixture.path)
			await collectModule(lowering, fixture.path, 'src/mixed.ts', code)
			await expect(lowering.plans()).rejects.toThrow(expectedError)
		},
	)

	it('builds a workspace producer from its package root into the host deployment root', async () => {
		const files = fixtureFiles()
		files['packages/nested/package.json'] = JSON.stringify({
			name: '@example/nested-plugin',
			type: 'module',
			devDependencies: {
				'@pluxel/workbench': '0.1.0',
				react: '19.3.0',
				'react-dom': '19.3.0',
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
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: 'Settings' },
	}),
})
class SemanticPlugin {
	declare ctx: { service(definition: typeof Workbench): Workbench }
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { settings: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'packages/nested/src/plugin.ts', code)
		const [compilation] = await lowering.compilations()
		const nestedRoot = resolve(fixture.path, 'packages/nested')

		expect(compilation?.root).toBe(nestedRoot)
		const bridgeEntryPath = compilation?.plan.entries[0]?.bridgeEntryPath
		expect(bridgeEntryPath).toMatch(/^\.pluxel\/workbench-generated\//)
		const generated = await readFile(resolve(nestedRoot, bridgeEntryPath!), 'utf-8')
		expect(generated).toContain('../../../../src/settings.tsx')
		expect(generated).not.toContain('plugin.ts')

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
		expect(validation).toMatchObject({ valid: true })
	}, 60_000)

	it('places an Attachment through its public re-exports without creating another producer', async () => {
		const files = fixtureFiles()
		files['src/provider.ts'] = `
import { workbench } from '@pluxel/workbench'
export const ProviderWorkbench = workbench.define(import.meta.url, {
	picker: workbench.attachment({ renderer: './picker.tsx' }),
})
`
		files['src/provider-public.ts'] =
			"export { ProviderWorkbench as FontTools } from './provider.ts'"
		files['src/provider-barrel.ts'] = "export * from './provider-public.ts'"
		files['src/provider-index.ts'] =
			"import { FontTools } from './provider-barrel.ts'; export { FontTools }"
		await using fixture = await createFixture(files)
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
import { FontTools } from './provider-index.ts'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	fonts: FontTools.picker.place({ kind: 'tab', label: 'Fonts' }),
})
class SemanticPlugin {
	init() {
		this.ctx.service(Workbench).publish(SemanticWorkbench, { fonts: { provider: this.provider } })
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
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({ renderer: './settings.tsx', placement: { kind: 'tab' } }),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { settings: () => ({}) }) }
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

	it('retains unselected imported invalidations when switching the selected catalog', async () => {
		const otherOwner = parsePluginDefinitionAddress({
			entry: owner.entry,
			exportName: 'OtherPlugin',
		})
		const otherDefinition = (document: string) => `import { workbench } from '@pluxel/workbench'
export const OtherWorkbench = workbench.define(import.meta.url, { guide: workbench.content({ document: '${document}', placement: { kind: 'tab', label: 'Other guide' } }) })`
		await using fixture = await createFixture({
			...fixtureFiles(),
			'src/first-workbench.ts': `import { workbench } from '@pluxel/workbench'
export const FirstWorkbench = workbench.define(import.meta.url, { guide: workbench.content({ document: './first.md', placement: { kind: 'tab', label: 'First guide' } }) })`,
			'src/other-workbench.ts': otherDefinition('./other-before.md'),
			'src/first.md': '# First guide\n',
			'src/other-before.md': '# Other before\n',
			'src/other-after.md': '# Other after\n',
		})
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		const id = resolve(fixture.path, 'src/owners.ts')
		const code = `
import { Workbench } from '@pluxel/workbench'
import { FirstWorkbench } from './first-workbench.ts'
import { OtherWorkbench } from './other-workbench.ts'
class SemanticPlugin { init() { this.ctx.service(Workbench).publish(FirstWorkbench) } }
class OtherPlugin { init() { this.ctx.service(Workbench).publish(OtherWorkbench) } }`
		await writeFile(id, code)
		await lowering.collect({
			id,
			code,
			ast: parseStandaloneWithLang(code, id)!,
			owners: [
				{ className: 'SemanticPlugin', definition: owner },
				{ className: 'OtherPlugin', definition: otherOwner },
			],
			resolve: async (source) =>
				source.startsWith('.') ? resolve(dirname(id), source) : undefined,
		})
		await expect(lowering.contentCompilations()).resolves.toHaveLength(2)
		const first = new Set([pluginDefinitionIndexKey(owner)])
		const other = new Set([pluginDefinitionIndexKey(otherOwner)])
		const [before] = await lowering.contentCompilations(other)
		expect(JSON.stringify(before!.contentSet)).toContain('Other before')
		const definitionPath = resolve(fixture.path, 'src/other-workbench.ts')
		await writeFile(definitionPath, otherDefinition('./other-after.md'))
		lowering.invalidate(definitionPath)
		await expect(lowering.contentCompilations(first)).resolves.toMatchObject([
			{ contentSet: { definition: owner } },
		])
		const [after] = await lowering.contentCompilations(other)
		expect(after?.digest).not.toBe(before?.digest)
		expect(JSON.stringify(after!.contentSet)).toContain('Other after')

		await writeFile(definitionPath, 'export const unfinished = true')
		lowering.invalidate(definitionPath)
		await expect(lowering.contentCompilations(first)).resolves.toHaveLength(1)
		await expect(lowering.contentCompilations(other)).rejects.toThrow('OtherWorkbench is missing')
		await writeFile(definitionPath, otherDefinition('./other-after.md'))
		await expect(lowering.contentCompilations(other)).resolves.toEqual([after])
	})

	it('refreshes imported definitions, renderer choices and failed reads in the same compiler', async () => {
		const content = `import { workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
 settings: workbench.content({ document: './guide.md', slots: { run: workbench.action({ label: 'Run' }) }, placement: { kind: 'tab', label: 'Settings' } }),
})`
		const view = `import { workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
 settings: workbench.view({ renderer: './settings.tsx', placement: { kind: 'tab' } }),
})`
		await using fixture = await createFixture({
			...fixtureFiles(),
			'src/workbench.ts': content,
			'src/guide.md': '# Guide\n\n::slot[run]\n',
		})
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		const plugin = `
import { Workbench } from '@pluxel/workbench'
import { SemanticWorkbench } from './workbench.ts'
class SemanticPlugin { init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { settings: () => ({}) }) } }`
		await collectModule(lowering, fixture.path, 'src/plugin.ts', plugin)
		await expect(lowering.plans()).resolves.toHaveLength(0)
		await expect(lowering.contentCompilations()).resolves.toHaveLength(1)
		const definitionPath = resolve(fixture.path, 'src/workbench.ts')
		await writeFile(definitionPath, view)
		lowering.invalidate(definitionPath)
		const [initialView] = await lowering.plans()
		expect(initialView).toBeDefined()
		const originalBridgePath = resolve(fixture.path, initialView!.entries[0]!.bridgeEntryPath)
		const originalBridge = await readFile(originalBridgePath, 'utf8')
		await expect(lowering.contentCompilations()).resolves.toHaveLength(0)

		await writeFile(definitionPath, view.replace('./settings.tsx', './picker.tsx'))
		lowering.invalidate(definitionPath)
		const [nextView] = await lowering.plans()
		expect(nextView?.buildRevision).not.toBe(initialView?.buildRevision)
		const bridge = await readFile(
			resolve(fixture.path, nextView!.entries[0]!.bridgeEntryPath),
			'utf8',
		)
		expect(bridge).toContain('picker.tsx')
		expect(nextView!.entries[0]!.bridgeEntryPath).not.toBe(initialView!.entries[0]!.bridgeEntryPath)
		expect(await readFile(originalBridgePath, 'utf8')).toBe(originalBridge)

		await writeFile(definitionPath, 'export const unfinished = true')
		lowering.invalidate(definitionPath)
		await expect(lowering.plans()).rejects.toThrow('SemanticWorkbench is missing')
		await writeFile(definitionPath, content)
		lowering.invalidate(definitionPath)
		await expect(lowering.plans()).resolves.toHaveLength(0)
		await expect(lowering.contentCompilations()).resolves.toHaveLength(1)

		// Removing an owner withdraws the entire desired tuple even though imported UI still exists.
		const pluginPath = resolve(fixture.path, 'src/plugin.ts')
		await rm(pluginPath)
		lowering.remove(pluginPath)
		await expect(lowering.contentCompilations()).resolves.toEqual([])
	})

	it.each(['replace', 'remove'] as const)(
		'does not let an in-flight collection write back after %s',
		async (operation) => {
			await using fixture = await createFixture({
				...fixtureFiles(),
				'src/guide.md': '# Guide\n',
			})
			const lowering = createWorkbenchSemanticLowering(fixture.path)
			const id = resolve(fixture.path, 'src/plugin.ts')
			const code = `import './delay.ts'
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, { guide: workbench.content({ document: './guide.md', placement: { kind: 'tab', label: 'Guide' } }) })
class SemanticPlugin { init() { this.ctx.service(Workbench).publish(SemanticWorkbench) } }`
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const pending = lowering.collect({
				id,
				code,
				ast: parseStandaloneWithLang(code, id)!,
				owners: [{ className: 'SemanticPlugin', definition: owner }],
				resolve: async () => {
					entered.resolve()
					await release.promise
					return undefined
				},
			})
			await entered.promise
			try {
				if (operation === 'replace')
					await collectModule(
						lowering,
						fixture.path,
						'src/plugin.ts',
						'export const ordinary = true',
					)
				else lowering.remove(id)
			} finally {
				release.resolve()
			}
			await pending
			await expect(lowering.contentCompilations()).resolves.toEqual([])
		},
	)

	it('discards an obsolete compilation result and its failed imported reads', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(
			lowering,
			fixture.path,
			'src/plugin.ts',
			`
import { Workbench } from '@pluxel/workbench'
import { SemanticWorkbench } from './missing.ts'
class SemanticPlugin { init() { this.ctx.service(Workbench).publish(SemanticWorkbench) } }`,
		)
		const obsolete = lowering.contentCompilations()
		lowering.remove(resolve(fixture.path, 'src/plugin.ts'))
		await expect(obsolete).resolves.toEqual([])
		await expect(lowering.contentCompilations()).resolves.toEqual([])
	})

	it('does not replace successful module facts when collection fails validation', async () => {
		await using fixture = await createFixture({ ...fixtureFiles(), 'src/guide.md': '# Guide\n' })
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		const code = `import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, { guide: workbench.content({ document: './guide.md', placement: { kind: 'tab', label: 'Guide' } }) })
class SemanticPlugin { init() { this.ctx.service(Workbench).publish(SemanticWorkbench) } }`
		await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
		const [before] = await lowering.contentCompilations()
		await expect(
			collectModule(
				lowering,
				fixture.path,
				'src/plugin.ts',
				code.replace('init() {', 'init() { if (true)'),
			),
		).rejects.toThrow('unconditional')
		lowering.invalidate()
		const [after] = await lowering.contentCompilations()
		expect(after?.digest).toBe(before?.digest)
	})

	it('requires a statically traceable binding for publication', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(
			lowering,
			fixture.path,
			'src/plugin.ts',
			`
import { Workbench, workbench } from '@pluxel/workbench'
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(workbench.define(import.meta.url, {}), {}) }
}`,
		)
		await expect(lowering.plans()).rejects.toThrow('statically traceable')
	})

	it('rejects publication from a helper or PluginPart instead of the owning Plugin', async () => {
		await using fixture = await createFixture(fixtureFiles())
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {})
class CapabilityPart {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, {}) }
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
		const workbenchPackage = 'node_modules/@pluxel/workbench/package.json'
		const manifest = JSON.parse(files[workbenchPackage]!)
		manifest.exports['.'] = { '@pluxel/source': './index.js', default: './index.js' }
		files[workbenchPackage] = JSON.stringify(manifest)
		files['src/plugin.ts'] = `
import { defineServiceRef, BasePlugin, Plugin } from '@pluxel/core'
import { workbench } from '@pluxel/workbench'
import type { Workbench } from '@pluxel/workbench'
const WorkbenchRef = defineServiceRef<Workbench>()
export const SemanticWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab' },
	}),
})
@Plugin()
export class SemanticPlugin extends BasePlugin {
	protected override init() {
		const publication = this.ctx.service(WorkbenchRef)?.publish(SemanticWorkbench, { settings: () => ({}) })
		publication?.link('settings')
	}
}
`
		await using fixture = await createFixture(files)
		const collector = createPluginSemanticsPlugin({ root: fixture.path })
		const bundle = await rolldown({
			input: resolve(fixture.path, 'src/plugin.ts'),
			external: ['@pluxel/core', '@pluxel/core/toolchain', '@pluxel/workbench'],
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
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({
		renderer: './settings.tsx',
		placement: { kind: 'tab', label: ${JSON.stringify(label)} },
	}),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { settings: () => ({}) }) }
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

	it('fingerprints the resolved UI closure while ignoring unrelated lockfile updates', async () => {
		const registry = 'node_modules/@example/registry-ui'
		const dependency = 'node_modules/@example/theme'
		const manifest = (version: string) =>
			JSON.stringify({
				name: '@example/theme',
				type: 'module',
				version,
				exports: { './label': './label.js' },
			})
		await using fixture = await createFixture({
			...fixtureFiles(),
			'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
			[registry + '/package.json']: JSON.stringify({
				name: '@example/registry-ui',
				type: 'module',
				exports: './index.js',
				dependencies: { '@example/theme': '^1.0.0' },
				optionalDependencies: { '@example/native': '^1.0.0' },
			}),
			[registry + '/index.js']: "export { label } from '@example/theme/label'",
			[dependency + '/package.json']: manifest('1.0.0'),
			[dependency + '/label.js']: "export const label = 'Settings'",
			'src/settings.tsx': `import { label } from '@example/registry-ui'
export default function Settings() { return label }`,
		})
		await symlink(
			resolve(fixture.path, 'uninstalled-platform-package'),
			resolve(fixture.path, 'node_modules/@example/native'),
			'dir',
		)
		const code = `
import { Workbench, workbench } from '@pluxel/workbench'
export const SemanticWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view({ renderer: './settings.tsx', placement: { kind: 'tab' } }),
})
class SemanticPlugin {
	init() { this.ctx.service(Workbench).publish(SemanticWorkbench, { settings: () => ({}) }) }
}
`
		const revision = async () => {
			const lowering = createWorkbenchSemanticLowering(fixture.path)
			await collectModule(lowering, fixture.path, 'src/plugin.ts', code)
			const [plan] = await lowering.plans()
			return plan!.buildRevision
		}

		const before = await revision()
		await writeFile(
			resolve(fixture.path, 'pnpm-lock.yaml'),
			'lockfileVersion: 9.0\npackages:\n  unrelated: 2.0.0\n',
		)
		expect(await revision()).toBe(before)
		await writeFile(resolve(fixture.path, dependency, 'package.json'), manifest('1.1.0'))
		expect(await revision()).not.toBe(before)

		await writeFile(
			resolve(fixture.path, 'src/settings.tsx'),
			"import '@example/native'; import { label } from '@example/registry-ui'; export default () => label",
		)
		await expect(revision()).rejects.toThrow('@example/native')
	})
})
