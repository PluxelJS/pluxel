import { execFileSync } from 'node:child_process'
import { readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
import {
	publishWorkbenchContentArtifact,
	writeWorkbenchContentDeploymentInventory,
} from '../src/workbench/content-artifact'

const testRequire = createRequire(import.meta.url)
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
				rewriteRelativeImportExtensions: true,
				strict: false,
				target: 'ES2022',
			},
			include: ['src', '.pluxel/workbench-generated'],
		}),
		'src/settings.tsx': 'export default function Settings() { return null }\n',
		'src/picker.tsx': 'export default function Picker() { return null }\n',
		'src/tool.tsx': 'export default function Tool() { return null }\n',
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
	content: (value) => value,
	attachment: (value) => Object.assign(value, { place: (placement) => ({ placement }) }),
	markdown: (_base, path, slots = {}) => ({ path, slots }),
	data: (schema) => ({ schema }),
	action: (value) => value,
	tab: (value) => value,
	define: (value) => Object.freeze(value),
})
`,
		'node_modules/@pluxel/runtime/workbench.d.ts': `
export type RendererEntry = Readonly<{ path: string }>
declare const apiType: unique symbol
declare const consumerApiType: unique symbol
type DescriptorBrand<Api, ConsumerApi = never> = Readonly<{
	[apiType]: (value: Api) => Api
	[consumerApiType]: (value: ConsumerApi) => ConsumerApi
}>
export type Entry<Api> = Readonly<{ renderer: RendererEntry }> & DescriptorBrand<Api>
export type Attachment<Api, ConsumerApi = never> = Entry<Api> &
	DescriptorBrand<Api, ConsumerApi> & { place(placement: unknown): unknown }
export type WorkbenchRenderableDescriptor = Readonly<{ renderer: RendererEntry }>
export type WorkbenchDescriptorApi<Descriptor> = Descriptor extends Readonly<{
	[apiType]: (value: infer Api) => unknown
}> ? Api : never
export type WorkbenchDescriptorConsumerApi<Descriptor> = Descriptor extends Readonly<{
	[consumerApiType]: (value: infer Api) => unknown
}> ? Api : never
export declare const workbench: {
	entry(base: string, path: string): RendererEntry
	view<Api>(value: Readonly<{ renderer: RendererEntry }> & Record<string, unknown>): Entry<Api>
	content(value: Record<string, unknown>): unknown
	attachment<Api, ConsumerApi = never>(
		value: Readonly<{ renderer: RendererEntry }> & Record<string, unknown>,
	): Attachment<Api, ConsumerApi>
	markdown(base: string, path: string, slots?: Record<string, unknown>): unknown
	data(schema: unknown): unknown
	action(value: Record<string, unknown>): unknown
	tab(value: Record<string, unknown>): unknown
	define<const Entries extends Record<string, unknown>>(value: Entries): Readonly<Entries>
}
`,
		'node_modules/@pluxel/runtime/workbench/react.js': `
export function useWorkbench() { return Object.freeze({ api: Object.freeze({}) }) }
export function createWorkbenchRenderer(descriptor) {
	return Object.freeze({
		render: (Component) => Component,
		useWorkbench: () => useWorkbench(descriptor),
	})
}
`,
		'node_modules/@pluxel/runtime/workbench/react.d.ts': `
import type {
	WorkbenchDescriptorApi,
	WorkbenchDescriptorConsumerApi,
	WorkbenchRenderableDescriptor,
} from '../workbench.js'
export declare function useWorkbench<Descriptor extends WorkbenchRenderableDescriptor>(
	descriptor: Descriptor,
): [WorkbenchDescriptorConsumerApi<Descriptor>] extends [never]
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
	useWorkbench(): ReturnType<typeof useWorkbench<Descriptor>>
}
`,
		'node_modules/@pluxel/runtime/internal/workbench-react.js': `
export function createWorkbenchBridge(identity, Renderer) {
	return Object.freeze({ identity, Renderer })
}
`,
		'node_modules/@pluxel/runtime/internal/workbench-react.d.ts': `
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
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench) }
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

	it('rejects unsafe or unsupported Markdown at the build boundary', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/content-invalid', type: 'module' }),
			'src/guide.md': '# Guide\n\n<script>alert(1)</script>\n',
		})
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.route({ path: '/guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench) }
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
import { workbench } from '@pluxel/runtime/workbench'
const StatusSchema = { marker: '${schemaSentinel}' }
const ProbeSchema = { marker: '${schemaSentinel}' }
const slots = {
	status: workbench.data(StatusSchema),
	probe: workbench.action({ label: 'Probe', input: ProbeSchema, form: 'embedded' }),
	dialog: workbench.action({ label: 'Dialog', input: ProbeSchema }),
clear: workbench.action({ label: 'Clear', confirm: 'Deletes cached state' }),
}
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md', slots),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench, { guide: () => ({}) }) }
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
import { workbench } from '@pluxel/runtime/workbench'
const StatusSchema = {}
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md', { status: ${slot} }),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench, { guide: () => ({}) }) }
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
import { workbench } from '@pluxel/runtime/workbench'
const StatusSchema = {}
const inherited = { inherited: workbench.data(StatusSchema) }
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md', ${slots}),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench, { guide: () => ({}) }) }
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
			'slots require exact static properties',
		)
	})

	it('rejects leading frontmatter before CommonMark can reinterpret it as content', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@example/content-frontmatter', type: 'module' }),
			'src/guide.md': '---\ntitle: Guide\n---\n\n# Guide\n',
		})
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench) }
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
import { workbench } from '@pluxel/runtime/workbench'
export const SemanticWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(SemanticWorkbench) }
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

	it('lowers one owner producer and generates exact descriptor-bound Bridge entries', async () => {
		await using fixture = await createFixture(fixtureFiles())
		await writeFile(
			resolve(fixture.path, 'src/settings.tsx'),
			`import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { SemanticWorkbench } from './plugin.ts'
export default function Settings() {
	const { api } = useWorkbench(SemanticWorkbench.settings)
	api.snapshot()
	// @ts-expect-error the browser projection must retain the exact View API
	api.select('not-a-settings-method')
	return null
}
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/picker.tsx'),
			`import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { SemanticWorkbench } from './plugin.ts'
export default function Picker() {
	const { provider, consumer } = useWorkbench(SemanticWorkbench.picker)
	provider.select('selected')
	consumer.preview('selected')
	// @ts-expect-error provider and consumer contracts must not collapse to any
	provider.preview('not-a-provider-method')
	return null
}
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/tool.tsx'),
			`import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { SemanticWorkbench } from './plugin.ts'
export default function Tool() {
	const { api } = useWorkbench(SemanticWorkbench.tool)
	api.run()
	// @ts-expect-error provider-only Attachment must retain its exact API
	api.preview('not-a-tool-method')
	return null
}
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/protocol.ts'),
			`import type { RpcTarget } from '@pluxel/runtime/capnweb'
export interface SettingsApi extends RpcTarget {
	snapshot(): { enabled: boolean }
}
export type PickerApi = RpcTarget & {
	select(id: string): Promise<void>
}
export interface PickerConsumerApi extends RpcTarget {
	preview(id: string): void
}
export type ToolApi = RpcTarget & { run(): void }
`,
			'utf-8',
		)
		await writeFile(
			resolve(fixture.path, 'src/protocol-index.ts'),
			`export type { PickerApi, PickerConsumerApi, SettingsApi, ToolApi } from './protocol.ts'\n`,
			'utf-8',
		)
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
import type { PickerApi, PickerConsumerApi, SettingsApi, ToolApi } from './protocol-index.ts'

const renderer = workbench.entry(import.meta.url, './settings.tsx')
function entries(viewRenderer: ReturnType<typeof workbench.entry>) {
	return {
		settings: workbench.view<SettingsApi>({
			renderer: viewRenderer,
			placement: workbench.tab({ label: 'Settings' }),
		}),
		picker: workbench.attachment<PickerApi, PickerConsumerApi>({
			renderer: workbench.entry(import.meta.url, './picker.tsx'),
		}),
		tool: workbench.attachment<ToolApi>({
			renderer: workbench.entry(import.meta.url, './tool.tsx'),
		}),
	}
}
export const SemanticWorkbench = workbench.define(entries(renderer))

class SemanticPlugin {
	declare ctx: { workbench?: { publish(definition: unknown, bindings: unknown): void } }
	init() {
		this.ctx.workbench?.publish(SemanticWorkbench, {
			settings: () => ({}),
			picker: () => ({}),
			tool: () => ({}),
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
				{ descriptor: { kind: 'attachment', owner, key: 'tool' }, expose: './views/tool' },
			],
		})
		const settings = plans[0]!.entries.find((entry) => entry.descriptor.key === 'settings')!
		const generated = await readFile(resolve(fixture.path, settings.bridgeEntryPath), 'utf-8')
		expect(generated).toContain(
			`createWorkbenchBridge(${JSON.stringify(settings.descriptor)}, Renderer)`,
		)
		expect(generated).not.toContain('SemanticWorkbench')
		expect(generated).not.toContain('Definition')
		expect(generated).toContain("from '@pluxel/runtime/internal/workbench-react'")
		const settingsProjection = await readFile(
			resolve(dirname(resolve(fixture.path, settings.bridgeEntryPath)), 'settings.definition.ts'),
			'utf-8',
		)
		expect(settingsProjection).toContain(
			'type SourceDescriptor = (typeof import("../../../../src/plugin.js"))["SemanticWorkbench"]["settings"]',
		)
		expect(settingsProjection).toContain('workbench.view({ renderer: ProjectedRenderer, placement:')
		expect(settingsProjection).toContain('as unknown as SourceDescriptor')
		expect(settingsProjection).not.toContain('workbench.view<any>')
		const picker = plans[0]!.entries.find((entry) => entry.descriptor.key === 'picker')!
		const pickerProjection = await readFile(
			resolve(dirname(resolve(fixture.path, picker.bridgeEntryPath)), 'picker.definition.ts'),
			'utf-8',
		)
		expect(pickerProjection).toContain(
			'type SourceDescriptor = (typeof import("../../../../src/plugin.js"))["SemanticWorkbench"]["picker"]',
		)
		expect(pickerProjection).toContain('workbench.attachment({ renderer: ProjectedRenderer })')
		expect(pickerProjection).not.toContain('workbench.attachment<any>')
		const tool = plans[0]!.entries.find((entry) => entry.descriptor.key === 'tool')!
		const toolProjection = await readFile(
			resolve(dirname(resolve(fixture.path, tool.bridgeEntryPath)), 'tool.definition.ts'),
			'utf-8',
		)
		expect(toolProjection).toContain(
			'type SourceDescriptor = (typeof import("../../../../src/plugin.js"))["SemanticWorkbench"]["tool"]',
		)
		expect(toolProjection).toContain('workbench.attachment({ renderer: ProjectedRenderer })')

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
		const packagedDefinitionDeclaration = resolve(
			dirname(settingsDeclarationPath),
			'../../../../src/plugin.d.ts',
		)
		await expect(readFile(packagedDefinitionDeclaration, 'utf-8')).resolves.toContain(
			"from './protocol-index.ts'",
		)
		await expect(
			readFile(resolve(dirname(packagedDefinitionDeclaration), 'protocol.d.ts'), 'utf-8'),
		).resolves.toContain('export type PickerApi = RpcTarget &')
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
		expect(validation.valid).toBe(true)
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

	it('projects one exact renderer scope through every importing page without executing the definition', async () => {
		const serverSentinel = 'SCOPE_SERVER_DEFINITION_MUST_NOT_EXECUTE_97ac'
		const files = fixtureFiles()
		files['src/server-label.ts'] = `export const serverLabel = '${serverSentinel}'\n`
		files['src/settings.types.ts'] = `
import type { ScopedWorkbench } from './workbench.ts'
export type SettingsDescriptor = typeof ScopedWorkbench.settings
`
		files['src/settings.scope.ts'] = `
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
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
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { serverLabel } from './server-label.ts'
interface SettingsApi extends RpcTarget { snapshot(): { enabled: boolean } }
export const ScopedWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: serverLabel }),
	}),
})
class SemanticPlugin {
	init() { this.ctx.workbench.publish(ScopedWorkbench, { settings: () => ({}) }) }
}
`
		const lowering = createWorkbenchSemanticLowering(fixture.path)
		await collectModule(lowering, fixture.path, 'src/workbench.ts', code)
		const [plan] = await lowering.plans()
		const bridgeEntryPath = resolve(fixture.path, plan!.entries[0]!.bridgeEntryPath)
		const generatedDir = dirname(bridgeEntryPath)
		const generatedFiles = await readdir(generatedDir)
		const generatedSources = await Promise.all(
			generatedFiles
				.filter((file) => /settings\.renderer(?:-module-\d+)?\.(?:ts|tsx)$/.test(file))
				.map((file) => readFile(resolve(generatedDir, file), 'utf-8')),
		)
		expect(generatedSources).toHaveLength(3)
		expect(
			generatedSources.filter((source) => source.includes('createWorkbenchRenderer(')),
		).toHaveLength(1)
		expect(
			generatedSources.filter((source) => source.includes('settingsRenderer.render(SettingsPage)')),
		).toHaveLength(1)
		expect(
			generatedSources.filter(
				(source) => source.includes('scope-page-marker') && source.includes('settingsRenderer'),
			),
		).toHaveLength(1)
		expect(generatedSources.join('\n')).toContain('./settings.definition.ts')
		expect(generatedSources.join('\n')).not.toContain('../src/settings.scope.ts')

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
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { ScopedWorkbench } from './workbench.ts'
export const settingsRenderer = createWorkbenchRenderer(ScopedWorkbench.other)
`
		files['src/settings.tsx'] = `
import { settingsRenderer } from './settings.scope.ts'
export default settingsRenderer.render(() => null)
`
		await using fixture = await createFixture(files)
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const ScopedWorkbench = workbench.define({
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
	other: workbench.view({
		renderer: workbench.entry(import.meta.url, './picker.tsx'),
		placement: workbench.tab({ label: 'Other' }),
	}),
})
class SemanticPlugin {
	init() {
		this.ctx.workbench.publish(ScopedWorkbench, { settings: () => ({}), other: () => ({}) })
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
import * as WorkbenchReact from '@pluxel/runtime/workbench/react'
import { ScopedWorkbench } from './workbench.ts'
const settingsRenderer = WorkbenchReact.createWorkbenchRenderer(ScopedWorkbench.other)
export default settingsRenderer.render(() => null)
`
		await using fixture = await createFixture(files)
		const code = `
import { workbench } from '@pluxel/runtime/workbench'
export const ScopedWorkbench = workbench.define({
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
	other: workbench.view({
		renderer: workbench.entry(import.meta.url, './picker.tsx'),
		placement: workbench.tab({ label: 'Other' }),
	}),
})
class SemanticPlugin {
	init() {
		this.ctx.workbench.publish(ScopedWorkbench, { settings: () => ({}), other: () => ({}) })
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
import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { MixedWorkbench } from './mixed'
export default function Settings() {
	useWorkbench(MixedWorkbench.settings)
	return null
}
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
import { workbench } from '@pluxel/runtime/workbench'
import { StatusSchema, ProbeSchema } from './content-schema'
import { probe } from './content-handler'

export const MixedWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md', {
			status: workbench.data(StatusSchema),
			probe: workbench.action({ label: 'Probe', input: ProbeSchema }),
		}),
		placement: workbench.tab({ label: 'Guide' }),
	}),
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
})
class SemanticPlugin {
	declare ctx: { workbench: { publish(definition: unknown, bindings: unknown): void } }
	init() {
		this.ctx.workbench.publish(MixedWorkbench, {
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
				/src\/settings-helper\.ts[\s\S]*"\.\/mixed"[\s\S]*does not bind a renderer scope[\s\S]*createWorkbenchRenderer\(MixedWorkbench\.settings\)/,
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
import { workbench } from '@pluxel/runtime/workbench'
export const MixedWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.tab({ label: 'Guide' }),
	}),
	settings: workbench.view({
		renderer: workbench.entry(import.meta.url, './settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
})
class SemanticPlugin {
	declare ctx: { workbench: { publish(definition: unknown, bindings: unknown): void } }
	init() { this.ctx.workbench.publish(MixedWorkbench, { guide: () => ({}), settings: () => ({}) }) }
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

	it('fingerprints resolved UI dependencies without hashing unrelated lockfile state', async () => {
		const files = fixtureFiles()
		files['pnpm-lock.yaml'] = 'lockfileVersion: 9.0\n'
		files['packages/producer/package.json'] = JSON.stringify({
			name: '@example/producer',
			version: '1.0.0',
			type: 'module',
		})
		files['packages/sibling-ui/package.json'] = JSON.stringify({
			name: '@example/sibling-ui',
			version: '1.0.0',
			type: 'module',
			exports: './src/index.ts',
		})
		files['packages/sibling-ui/src/index.ts'] = "export const siblingLabel = 'sibling-v1'\n"
		files['node_modules/@example/registry-ui/package.json'] = JSON.stringify({
			name: '@example/registry-ui',
			version: '1.0.0',
			type: 'module',
			exports: './index.js',
			dependencies: {
				'@example/registry-theme': '^1.0.0',
				'@example/subpath-only': '^1.0.0',
			},
		})
		files['node_modules/@example/registry-ui/index.js'] =
			"export { themeLabel as registryLabel } from '@example/registry-theme'\n"
		files['node_modules/@example/registry-theme/package.json'] = JSON.stringify({
			name: '@example/registry-theme',
			version: '1.0.0',
			type: 'module',
			exports: './index.js',
		})
		files['node_modules/@example/registry-theme/index.js'] = "export const themeLabel = 'theme'\n"
		files['node_modules/@example/subpath-only/package.json'] = JSON.stringify({
			name: '@example/subpath-only',
			version: '1.0.0',
			type: 'module',
			exports: { './icon': './icon.js' },
		})
		files['node_modules/@example/subpath-only/icon.js'] = 'export const icon = true\n'
		files['packages/producer/src/settings.tsx'] = `
import { siblingLabel } from '@example/sibling-ui'
import { registryLabel } from '@example/registry-ui'
export default function Settings() { return siblingLabel + registryLabel }
`
		await using fixture = await createFixture(files)
		await symlink(
			resolve(fixture.path, 'packages/sibling-ui'),
			resolve(fixture.path, 'node_modules/@example/sibling-ui'),
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
	init() { this.ctx.workbench.publish(SemanticWorkbench, { settings: () => ({}) }) }
}
`
		const revisionAt = async (root: string) => {
			const lowering = createWorkbenchSemanticLowering(root)
			await collectModule(lowering, root, 'packages/producer/src/plugin.ts', code)
			const plans = await lowering.plans()
			return plans[0]!.buildRevision
		}
		const revision = () => revisionAt(fixture.path)

		const initialRevision = await revision()
		await using equivalentFixture = await createFixture(files)
		await symlink(
			resolve(equivalentFixture.path, 'packages/sibling-ui'),
			resolve(equivalentFixture.path, 'node_modules/@example/sibling-ui'),
			'dir',
		)
		expect(await revisionAt(equivalentFixture.path)).toBe(initialRevision)
		await writeFile(
			resolve(fixture.path, 'pnpm-lock.yaml'),
			'lockfileVersion: 9.0\npackages:\n  unrelated: 2.0.0\n',
		)
		expect(await revision()).toBe(initialRevision)
		await writeFile(
			resolve(fixture.path, 'node_modules/@example/registry-ui/package.json'),
			JSON.stringify({
				name: '@example/registry-ui',
				version: '1.0.0',
				type: 'module',
				exports: './index.js',
				dependencies: {
					'@example/registry-theme': '^1.0.0',
					'@example/subpath-only': '^1.0.0',
				},
				description: 'non-build metadata changed',
				scripts: { test: 'exit 1' },
			}),
		)
		expect(await revision()).toBe(initialRevision)
		await writeFile(
			resolve(fixture.path, 'node_modules/@example/registry-ui/package.json'),
			JSON.stringify({
				name: '@example/registry-ui',
				version: '1.0.0',
				type: 'module',
				exports: './index.js',
				sideEffects: false,
				dependencies: {
					'@example/registry-theme': '^1.0.0',
					'@example/subpath-only': '^1.0.0',
				},
				description: 'non-build metadata changed',
				scripts: { test: 'exit 1' },
			}),
		)
		const packageMetadataRevision = await revision()
		expect(packageMetadataRevision).not.toBe(initialRevision)

		await writeFile(
			resolve(fixture.path, 'packages/sibling-ui/src/index.ts'),
			"export const siblingLabel = 'sibling-v2'\n",
		)
		const siblingRevision = await revision()
		expect(siblingRevision).not.toBe(packageMetadataRevision)

		await writeFile(
			resolve(fixture.path, 'node_modules/@example/registry-theme/package.json'),
			JSON.stringify({
				name: '@example/registry-theme',
				version: '1.1.0',
				type: 'module',
				exports: './index.js',
			}),
		)
		const transitiveRevision = await revision()
		expect(transitiveRevision).not.toBe(siblingRevision)

		await writeFile(
			resolve(fixture.path, 'node_modules/@example/subpath-only/package.json'),
			JSON.stringify({
				name: '@example/subpath-only',
				version: '1.1.0',
				type: 'module',
				exports: { './icon': './icon.js' },
			}),
		)
		expect(await revision()).not.toBe(transitiveRevision)
	})
})
