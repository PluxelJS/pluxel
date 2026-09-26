import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	openProject,
	type InspectionSection,
	type InspectionSectionData,
	type InspectionSourceLocation,
} from '../src/inspect/index.ts'

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
  plugins: [MailPlugin],
  services: prepareServices(),
  configRecords: makeRecords(),
  envBindings: [envBinding(MailPlugin, { config: { schema: Schema, mapping: ${mapping} } })],
  fileBindings: [fileBinding(MailPlugin, { config: { schema: Schema, path: './private/config.json' } })],
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
		'package.json': JSON.stringify({ private: true, workspaces: ['plugins/*'] }),
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
	it('resolves from the application, isolates entries, and locates inputs without executing source', async () => {
		await using fixture = await packageFixture()
		await using project = await openProject({ root: fixture.path })
		const workspace = await project.plugin(reference)
		expect(workspace.data.summary.declaration.file).toBe(
			fixture.getPath('plugins/mail/src/index.ts'),
		)
		const summary = await project.plugin(reference, {
			application: { root: 'host', entry: 'a.ts' },
		})
		expect(summary.data.summary.declaration.file).toBe(
			fixture.getPath('installed/mail/src/index.ts'),
		)
		const [a, b] = await Promise.all(
			['a.ts', 'b.ts'].map((entry) =>
				project.plugin(reference, {
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
			expect(selectedText(application('@fixture/mail', name), inputs.configRecords!)).toBe(
				'makeRecords()',
			)
			expect(available(result.data.sections.config).declarations).toHaveLength(2)
		}
		const part = await project.plugin(reference, {
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

	it('rejects a binding that resolves the same Plugin address to another physical source', async () => {
		await using fixture = await packageFixture()
		await writeFile(
			fixture.getPath('host/a.ts'),
			application('../plugins/mail/src/index', 'WORKSPACE_COPY'),
		)
		await using project = await openProject({ root: fixture.path })
		await expect(
			project.plugin(reference, {
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
		await using project = await openProject({ root: fixture.path })
		const local = await project.plugin('source:app/local.ts::MailPlugin', {
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
		const managed = await project.plugin('source:managed/mail.ts::MailPlugin', {
			application: applicationSelection,
			include: ['inputs'],
		})
		expect(managed.data.summary.declaration.file).toBe(fixture.getPath('host/managed/mail.ts'))
		expect(available(managed.data.sections.inputs).bindings[0]!.source).toMatchObject({
			kind: 'env',
			name: 'MANAGED',
		})
		await expect(
			project.plugin('source:app/managed/mail.ts::MailPlugin', {
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
		await using project = await openProject({ root: fixture.path })
		await expect(
			project.plugin('source:app/escaped.ts::MailPlugin', {
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
		await using project = await openProject({ root: fixture.path })
		const result = await project.plugin('source:shared/mail.ts::MailPlugin', {
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
		await using project = await openProject({ root: fixture.path })
		const result = await project.plugin('source:app/mail.ts::MailPlugin', {
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
		await using project = await openProject({ root: fixture.path })
		const sourceSpace = { name: 'managed', root: 'managed' }
		const selection = { root: 'host', entry: 'app.ts', sourceSpaces: [sourceSpace] }
		const pending = project.plugin('source:managed/mail.ts::MailPlugin', {
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

	it('requires application for inputs and preserves literal and dynamic section typing', async () => {
		await using fixture = await packageFixture()
		await using project = await openProject({ root: fixture.path })
		await expect(project.plugin(reference, { include: ['inputs'] })).rejects.toMatchObject({
			code: 'invalid_input',
		})
		await expect(project.plugin('source:app/mail.ts::MailPlugin')).rejects.toMatchObject({
			code: 'invalid_input',
		})
		const selectedApplication = { root: 'host', entry: 'a.ts' }
		const literal = await project.plugin(reference, {
			application: selectedApplication,
			include: ['inputs'],
		})
		expectTypeOf<keyof typeof literal.data.sections>().toEqualTypeOf<'inputs'>()
		expectTypeOf(literal.data.sections.inputs).toEqualTypeOf<
			InspectionSection<InspectionSectionData['inputs']>
		>()
		const include: ('inputs' | 'config')[] = ['inputs']
		const dynamic = await project.plugin(reference, { application: selectedApplication, include })
		expectTypeOf(dynamic.data.sections.inputs).toEqualTypeOf<
			InspectionSection<InspectionSectionData['inputs']> | undefined
		>()
	})
})
