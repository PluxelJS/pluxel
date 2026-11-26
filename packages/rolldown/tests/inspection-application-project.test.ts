import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import {
	inspectPlugin,
	listPlugins,
	inspectFile,
	type InspectionSection,
	type InspectionSourceLocation,
} from '@pluxel/agent-sdk/source'

const reference = 'package:@fixture/mail::MailPlugin'
const plugin = `
import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'
export const Schema = (() => { throw new Error('SCHEMA_MUST_NOT_EXECUTE') })()
export class Retry extends PluginPart { settings = this.configs.use(Schema) }
@Plugin() export class MailPlugin extends BasePlugin {
  settings = this.configs.use(Schema)
  retry = this.parts.use(Retry)
}
throw new Error('PLUGIN_MUST_NOT_EXECUTE')
`
const manifest = JSON.stringify({
	name: '@fixture/mail',
	type: 'module',
	exports: { '.': { '@pluxel/source': './src/index.ts', default: './dist/index.js' } },
})
function application(source: string, name: string, mapping = `{ endpoint: '${name}' }`) {
	return `
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
import { MailPlugin, Schema } from '${source}'
throw new Error('ENTRY_MUST_NOT_EXECUTE')
export default defineHostApplication(() => ({
  plugins: [{
    plugin: MailPlugin,
    config: computeConfig(),
    envBindings: [envBinding({ config: { schema: Schema, mapping: ${mapping} } })],
    fileBindings: [fileBinding({ config: { schema: Schema, path: './private/config.json' } })],
  }],
  services: prepareServices(),
}))
`
}
function available<T>(section: InspectionSection<T>): T {
	expect(section.status).not.toBe('unavailable')
	if (section.status === 'unavailable') throw new Error(section.reason.message)
	return section.value
}
function selectedText(code: string, location: InspectionSourceLocation) {
	const offset = (position: { line: number; column: number }) =>
		code
			.split('\n')
			.slice(0, position.line - 1)
			.reduce((sum, line) => sum + line.length + 1, 0) +
		position.column -
		1
	return code.slice(offset(location.start), offset(location.end))
}
async function packageFixture() {
	const fixture = await createFixture({
		'package.json': JSON.stringify({ private: true }),
		'pnpm-workspace.yaml': 'packages:\n  - plugins/*\n',
		'plugins/mail/package.json': manifest,
		'plugins/mail/src/index.ts': plugin,
		'installed/mail/package.json': manifest,
		'installed/mail/src/index.ts': plugin,
		'host/package.json': JSON.stringify({ private: true, type: 'module' }),
		'host/a.ts': application('@fixture/mail', 'MAIL_A'),
		'host/b.ts': application('@fixture/mail', 'MAIL_B'),
	})
	await mkdir(fixture.getPath('host/node_modules/@fixture'), { recursive: true })
	await symlink(
		fixture.getPath('installed/mail'),
		fixture.getPath('host/node_modules/@fixture/mail'),
		'dir',
	)
	return fixture
}

describe('application-aware public Plugin inspection', () => {
	it('discovers local source definitions without package exports or a Host and follows their returned addresses', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ private: true }),
			'host/app.ts': "import './barrel'; throw new Error('APP_MUST_NOT_RUN')",
			'host/barrel.ts': "export { MailPlugin } from './mail'; import './other'",
			'host/mail.ts': plugin,
			'host/other.ts':
				"import { BasePlugin, Plugin } from '@pluxel/core'; @Plugin() export class MailPlugin extends BasePlugin {}",
			'host/unrelated.ts': "throw new Error('OUTSIDE_THE_SELECTED_IMPORT_GRAPH')",
		})
		const options = { root: fixture.path, application: { root: 'host', entry: 'app.ts' } }
		const first = await listPlugins({ ...options, limit: 1 })
		expect(first.data.status).toBe('complete')
		const firstPage = available(first.data)
		expect(firstPage.items).toHaveLength(1)
		expect(firstPage.nextCursor).not.toBeNull()
		const second = await listPlugins({ ...options, cursor: firstPage.nextCursor! })
		const items = [...firstPage.items, ...available(second.data).items]
		expect(items.map((item) => item.reference)).toEqual([
			'source:app/mail.ts::MailPlugin',
			'source:app/other.ts::MailPlugin',
		])
		for (const item of items) {
			const located = await inspectPlugin(item.definition, options)
			expect(located.data.summary).toEqual(item)
		}
		const owners = await inspectFile('host/mail.ts', options)
		expect(available(owners.data).items.map((item) => item.definition)).toEqual([
			items[0]!.definition,
		])
		await writeFile(fixture.getPath('host/barrel.ts'), "export { MailPlugin } from './other'")
		await expect(listPlugins({ ...options, cursor: firstPage.nextCursor! })).rejects.toMatchObject({
			code: 'cursor_stale',
		})
	})

	it('reports dynamic source imports as gaps instead of claiming an exhaustive application inventory', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ private: true }),
			'host/app.ts': "import './mail'; void import(pluginEntry)",
			'host/mail.ts': plugin,
		})
		const result = await listPlugins({
			root: fixture.path,
			application: { root: 'host', entry: 'app.ts' },
		})
		expect(result.data).toMatchObject({
			status: 'partial',
			value: { items: [{ exportName: 'MailPlugin' }] },
			gaps: [{ code: 'dynamic_source_import' }],
		})
	})

	it('resolves from the application, isolates entries, and locates inputs without executing source', async () => {
		await using fixture = await packageFixture()
		const context = { root: fixture.path }
		const workspace = await inspectPlugin(reference, context)
		expect(workspace.data.summary.declaration.file).toBe(
			fixture.getPath('plugins/mail/src/index.ts'),
		)
		const summary = await inspectPlugin(reference, {
			...context,
			application: { root: 'host', entry: 'a.ts' },
		})
		expect(summary.data.summary.declaration.file).toBe(
			fixture.getPath('installed/mail/src/index.ts'),
		)
		const [a, b] = await Promise.all(
			['a.ts', 'b.ts'].map((entry) =>
				inspectPlugin(reference, {
					...context,
					application: { root: 'host', entry },
					include: ['config', 'inputs'],
				}),
			),
		)
		for (const [result, name, entry] of [
			[a!, 'MAIL_A', 'a.ts'],
			[b!, 'MAIL_B', 'b.ts'],
		] as const) {
			expect(result.data.sections.inputs.status).toBe('complete')
			const inputs = available(result.data.sections.inputs)
			expect(inputs.application.root).toBe(fixture.getPath('host'))
			expect(inputs.application.entry).toBe(fixture.getPath(`host/${entry}`))
			expect(inputs.application.sourceSpaces).toContainEqual({
				name: 'app',
				root: fixture.getPath('host'),
			})
			expect(
				inputs.bindings.map((binding) =>
					binding.source.kind === 'env' ? binding.source.name : binding.source.path,
				),
			).toEqual([name, './private/config.json'])
			expect(inputs.bindings.map((binding) => binding.configPath)).toEqual([['endpoint'], []])
			expect(inputs.bindings[0]!.schema.declaration?.file).toBe(
				fixture.getPath('installed/mail/src/index.ts'),
			)
			expect(selectedText(application('@fixture/mail', name), inputs.config!)).toBe(
				'computeConfig()',
			)
			expect(available(result.data.sections.config).declarations).toHaveLength(2)
		}
		const part = await inspectPlugin(reference, {
			...context,
			application: { root: 'host', entry: 'a.ts' },
			partPath: ['retry'],
			include: ['config', 'inputs'],
		})
		expect(available(part.data.sections.config).declarations.map((item) => item.partPath)).toEqual([
			['retry'],
		])
		expect(available(part.data.sections.inputs).bindings).toEqual(
			available(a!.data.sections.inputs).bindings,
		)
		expect(Object.isFrozen(available(a!.data.sections.inputs).application.sourceSpaces)).toBe(true)
	})

	it('inspects a subpath-only package and resolves its public entry from the application', async () => {
		await using fixture = await packageFixture()
		const subpathManifest = JSON.stringify({
			name: '@fixture/mail',
			type: 'module',
			exports: {
				'./plugins': { '@pluxel/source': './src/index.ts', default: './dist/plugins.js' },
			},
		})
		await Promise.all([
			writeFile(fixture.getPath('plugins/mail/package.json'), subpathManifest),
			writeFile(fixture.getPath('installed/mail/package.json'), subpathManifest),
			writeFile(fixture.getPath('host/a.ts'), application('@fixture/mail/plugins', 'MAIL_UI')),
		])
		const context = { root: fixture.path }
		const subpathReference = 'package:@fixture/mail/plugins::MailPlugin'
		const listResult = await listPlugins({ ...context, packageName: '@fixture/mail' })
		const listed = available(listResult.data)
		expect(listed.items.map((item) => item.reference)).toEqual([subpathReference])
		const workspace = await inspectPlugin(subpathReference, context)
		expect(workspace.data.summary.declaration.file).toBe(
			fixture.getPath('plugins/mail/src/index.ts'),
		)
		const installed = await inspectPlugin(subpathReference, {
			...context,
			application: { root: 'host', entry: 'a.ts' },
			include: ['config', 'inputs'],
		})
		expect(installed.data.summary.declaration.file).toBe(
			fixture.getPath('installed/mail/src/index.ts'),
		)
		expect(
			available(installed.data.sections.inputs).bindings.map((binding) => binding.source.kind),
		).toEqual(['env', 'file'])
		expect(available(installed.data.sections.config).declarations).toHaveLength(2)
	})

	it('rejects a binding that resolves the same Plugin address to another physical source', async () => {
		await using fixture = await packageFixture()
		await writeFile(
			fixture.getPath('host/a.ts'),
			application('../plugins/mail/src/index', 'WORKSPACE_COPY'),
		)
		const context = { root: fixture.path }
		await expect(
			inspectPlugin(reference, {
				...context,
				application: { root: 'host', entry: 'a.ts' },
				include: ['inputs'],
			}),
		).rejects.toMatchObject({ code: 'analysis_unavailable' })
	})

	it('supports app and explicit source spaces using canonical paths', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ private: true }),
			'host/local.ts': plugin,
			'host/managed/mail.ts': plugin,
			'host/local-app.ts': application('./local', 'LOCAL'),
			'host/managed-app.ts': application('./managed/mail', 'MANAGED'),
		})
		const context = { root: fixture.path }
		const local = await inspectPlugin('source:app/local.ts::MailPlugin', {
			...context,
			application: { root: 'host', entry: 'local-app.ts' },
			include: ['inputs'],
		})
		expect(available(local.data.sections.inputs).bindings[0]!.source).toMatchObject({
			kind: 'env',
			name: 'LOCAL',
		})
		const applicationSelection = {
			root: 'host',
			entry: 'managed-app.ts',
			sourceSpaces: [{ name: 'managed', root: 'managed' }],
		}
		const managed = await inspectPlugin('source:managed/mail.ts::MailPlugin', {
			...context,
			application: applicationSelection,
			include: ['inputs'],
		})
		expect(managed.data.summary.declaration.file).toBe(fixture.getPath('host/managed/mail.ts'))
		expect(available(managed.data.sections.inputs).bindings[0]!.source).toMatchObject({
			kind: 'env',
			name: 'MANAGED',
		})
		await expect(
			inspectPlugin('source:app/managed/mail.ts::MailPlugin', {
				...context,
				application: applicationSelection,
			}),
		).rejects.toMatchObject({ code: 'analysis_unavailable' })
	})

	it('rejects source aliases that escape their declared source space', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ private: true }),
			'host/app.ts': application('./escaped', 'ESCAPED'),
			'outside/mail.ts': plugin,
		})
		await symlink(fixture.getPath('outside/mail.ts'), fixture.getPath('host/escaped.ts'))
		const context = { root: fixture.path }
		await expect(
			inspectPlugin('source:app/escaped.ts::MailPlugin', {
				...context,
				application: { root: 'host', entry: 'app.ts' },
			}),
		).rejects.toMatchObject({ code: 'analysis_unavailable' })
	})

	it('resolves relative source mappings before canonicalizing a symlinked application root', async () => {
		await using fixture = await createFixture({
			'package.json': '{}',
			'physical/host/app.ts': application('../../shared/mail', 'SHARED'),
			'shared/mail.ts': plugin,
		})
		await symlink(fixture.getPath('physical/host'), fixture.getPath('linked-host'), 'dir')
		const context = { root: fixture.path }
		const result = await inspectPlugin('source:shared/mail.ts::MailPlugin', {
			...context,
			application: {
				root: 'linked-host',
				entry: 'app.ts',
				sourceSpaces: [{ name: 'shared', root: '../shared' }],
			},
			include: ['inputs'],
		})
		const inputs = available(result.data.sections.inputs)
		expect(inputs.application.root).toBe(fixture.getPath('physical/host'))
		expect(inputs.application.sourceSpaces).toContainEqual({
			name: 'shared',
			root: fixture.getPath('shared'),
		})
		expect(inputs.bindings[0]!.source).toMatchObject({ kind: 'env', name: 'SHARED' })
	})

	it('retains known mapping leaves and source locations for dynamic gaps', async () => {
		const code = application('./mail', 'KNOWN', "{ known: 'KNOWN', dynamic: computeName() }")
		await using fixture = await createFixture({
			'package.json': '{}',
			'host/mail.ts': plugin,
			'host/app.ts': code,
		})
		const context = { root: fixture.path }
		const result = await inspectPlugin('source:app/mail.ts::MailPlugin', {
			...context,
			application: { root: 'host', entry: 'app.ts' },
			include: ['inputs'],
		})
		const section = result.data.sections.inputs
		expect(section.status).toBe('partial')
		expect(available(section).bindings.map((binding) => binding.configPath)).toEqual([
			['known'],
			[],
		])
		if (section.status !== 'partial') throw new Error('Expected a dynamic mapping gap')
		expect(
			section.gaps.some(
				(gap) =>
					gap.code === 'unsupported_expression' &&
					gap.location &&
					selectedText(code, gap.location) === 'computeName()',
			),
		).toBe(true)
	})

	it('copies nested application options before query admission', async () => {
		await using fixture = await createFixture({
			'package.json': '{}',
			'host/managed/mail.ts': plugin,
			'host/app.ts': application('./managed/mail', 'ORIGINAL'),
		})
		const context = { root: fixture.path }
		const sourceSpace = { name: 'managed', root: 'managed' }
		const selection = { root: 'host', entry: 'app.ts', sourceSpaces: [sourceSpace] }
		const pending = inspectPlugin('source:managed/mail.ts::MailPlugin', {
			...context,
			application: selection,
			include: ['inputs'],
		})
		selection.root = 'missing'
		selection.entry = 'missing.ts'
		sourceSpace.name = 'different'
		sourceSpace.root = 'missing'
		selection.sourceSpaces.push({ name: 'another', root: 'missing' })
		const result = await pending
		expect(available(result.data.sections.inputs).application.sourceSpaces).toContainEqual({
			name: 'managed',
			root: fixture.getPath('host/managed'),
		})
	})

	it('requires an application for input inspection and source-entry references', async () => {
		await using fixture = await packageFixture()
		const context = { root: fixture.path }
		await expect(
			inspectPlugin(reference, { ...context, include: ['inputs'] }),
		).rejects.toMatchObject({
			code: 'invalid_input',
		})
		await expect(inspectPlugin('source:app/mail.ts::MailPlugin', context)).rejects.toMatchObject({
			code: 'invalid_input',
		})
	})
})
