import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
	openProject,
	type InspectionSection,
	type InspectionSectionData,
} from '../src/inspect/index.ts'

const roots: string[] = []
const mailReference = 'package:@fixture/mail::MailPlugin'
function available<T>(section: InspectionSection<T>): T {
	expect(section.status).not.toBe('unavailable')
	if (section.status === 'unavailable') throw new Error(section.reason.message)
	return section.value
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-inspection-project-'))
	roots.push(root)
	const packageRoot = join(root, 'plugins/mail')
	await mkdir(join(packageRoot, 'src'), { recursive: true })
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ private: true, workspaces: ['plugins/*'] }),
	)
	await writeFile(
		join(packageRoot, 'package.json'),
		JSON.stringify({
			name: '@fixture/mail',
			type: 'module',
			exports: { '.': { '@pluxel/source': './src/index.ts', default: './dist/index.js' } },
			scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
		}),
	)
	await writeFile(
		join(packageRoot, 'src/schema.ts'),
		`
import * as v from 'valibot'
export const SharedSchema = v.object({ retries: v.optional(v.number(), 3) })
throw new Error('SCHEMA_MUST_NOT_EXECUTE')
`,
	)
	await writeFile(
		join(packageRoot, 'src/shared.ts'),
		`
import { PluginPart } from '@pluxel/core'
import { SharedSchema } from './schema'
export class SharedPart extends PluginPart {
  readonly config = this.configs.use(SharedSchema)
}
`,
	)
	await writeFile(
		join(packageRoot, 'src/index.ts'),
		`
import { BasePlugin, Plugin } from '@pluxel/core'
import { SharedPart } from './shared'
@Plugin() export class MailPlugin extends BasePlugin {
  readonly primary = this.parts.use(SharedPart)
  readonly backup = this.parts.use(SharedPart)
}
@Plugin() export class OtherPlugin extends BasePlugin {
  readonly shared = this.parts.use(SharedPart)
}
throw new Error('PLUGIN_MUST_NOT_EXECUTE')
`,
	)
	return { root, packageRoot }
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project inspection public API', () => {
	it('lists package Plugins and locates repeated Part config without executing project code', async () => {
		const { root, packageRoot } = await fixture()
		await using project = await openProject({ root })
		const listResult = await project.plugins({ packageName: '@fixture/mail' })
		const list = available(listResult.data)
		expect(list.items.map((item) => item.exportName).sort()).toEqual(['MailPlugin', 'OtherPlugin'])
		expect(list.nextCursor).toBeNull()
		const result = await project.plugin(mailReference, { include: ['parts', 'config', 'checks'] })
		expect(result.data.summary.reference).toBe(mailReference)
		expect(result.data.summary.declaration.file).toBe(join(packageRoot, 'src/index.ts'))
		expect(Object.keys(result.data.sections).sort()).toEqual(['checks', 'config', 'parts'])
		const parts = available(result.data.sections.parts).occurrences
		expect(parts.map((part) => part.partPath).sort()).toEqual([['backup'], ['primary']])
		const configs = available(result.data.sections.config).declarations
		expect(configs.map((config) => config.configPath).sort()).toEqual([['backup'], ['primary']])
		for (const config of configs) {
			expect(config.schema.declaration?.file).toBe(join(packageRoot, 'src/schema.ts'))
			expect(config.schema.symbol).toBe('SharedSchema')
			expect(config.declaration.start.line).toBeGreaterThan(0)
		}
		expect(
			available(result.data.sections.checks)
				.scripts.map((script) => script.name)
				.sort(),
		).toEqual(['test', 'typecheck'])
		const typed = await project.plugin(mailReference, { include: ['config'] })
		expectTypeOf<keyof typeof typed.data.sections>().toEqualTypeOf<'config'>()
		const summary = await project.plugin(mailReference)
		expect(summary.data.sections).toEqual({})
	})

	it('filters by occurrence while retaining canonical Plugin ownership', async () => {
		const { root } = await fixture()
		await using project = await openProject({ root })
		const result = await project.plugin(mailReference, {
			partPath: ['backup'],
			include: ['parts', 'config'],
		})
		expect(result.data.summary.reference).toBe(mailReference)
		expect(available(result.data.sections.parts).occurrences.map((part) => part.partPath)).toEqual([
			['backup'],
		])
		expect(
			available(result.data.sections.config).declarations.map((config) => config.configPath),
		).toEqual([['backup']])
		await expect(project.plugin(mailReference, { partPath: ['missing'] })).rejects.toMatchObject({
			code: 'part_not_found',
		})
	})

	it('finds all public owners of a shared schema and Part', async () => {
		const { root } = await fixture()
		await using project = await openProject({ root })
		const schemaResult = await project.file('plugins/mail/src/schema.ts')
		const schema = available(schemaResult.data)
		expect(schema.scope).toBe('workspace-plugin-declarations')
		expect(schema.items.map((item) => item.definition.exportName).sort()).toEqual([
			'MailPlugin',
			'OtherPlugin',
		])
		const mail = schema.items.find((item) => item.reference === mailReference)!
		expect(mail.relations.map((relation) => relation.kind)).toEqual([
			'config-schema',
			'config-schema',
		])
		expect(mail.relations.map((relation) => relation.partPath).sort()).toEqual([
			['backup'],
			['primary'],
		])
		const partResult = await project.file('plugins/mail/src/shared.ts')
		const part = available(partResult.data)
		expect(part.items.map((item) => item.definition.exportName).sort()).toEqual([
			'MailPlugin',
			'OtherPlugin',
		])
		expect(
			part.items.every((item) => item.relations.some((relation) => relation.kind === 'part')),
		).toBe(true)
	})

	it('rereads changed schemas and rejects pagination over changed inputs', async () => {
		const { root, packageRoot } = await fixture()
		await using project = await openProject({ root })
		const before = await project.plugin(mailReference, { include: ['config'] })
		const firstResult = await project.plugins({ packageName: '@fixture/mail', limit: 1 })
		const first = available(firstResult.data)
		expect(first.nextCursor).not.toBeNull()
		const nextResult = await project.plugins({
			packageName: '@fixture/mail',
			limit: 1,
			cursor: first.nextCursor!,
		})
		const next = available(nextResult.data)
		expect(next.items[0]!.reference).not.toBe(first.items[0]!.reference)
		await writeFile(join(packageRoot, 'src/schema.ts'), `\n\nexport const SharedSchema = {}\n`)
		const after = await project.plugin(mailReference, { include: ['config'] })
		expect(after.revision).not.toBe(before.revision)
		expect(
			available(after.data.sections.config).declarations[0]!.schema.declaration?.start.line,
		).toBe(3)
		await writeFile(
			join(packageRoot, 'src/index.ts'),
			`import { BasePlugin, Plugin } from '@pluxel/core'\n@Plugin() export class RenamedPlugin extends BasePlugin {}`,
		)
		await expect(
			project.plugins({ packageName: '@fixture/mail', limit: 1, cursor: first.nextCursor! }),
		).rejects.toMatchObject({ code: 'cursor_stale' })
		const renamed = await project.plugins({ packageName: '@fixture/mail' })
		expect(available(renamed.data).items.map((item) => item.exportName)).toEqual(['RenamedPlugin'])
		expect(before.data.summary.exportName).toBe('MailPlugin')
	})

	it('has stable failure codes for cancellation, disposal and invalid inputs', async () => {
		const { root } = await fixture()
		await expect(openProject({ root, signal: AbortSignal.abort() })).rejects.toMatchObject({
			code: 'aborted',
		})
		const project = await openProject({ root })
		await expect(project.overview({ signal: AbortSignal.abort() })).rejects.toMatchObject({
			code: 'aborted',
		})
		await expect(project.plugins({ limit: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
		await expect(project.plugin('not-a-plugin')).rejects.toMatchObject({ code: 'invalid_input' })
		await expect(project.plugin('package:@fixture/mail::MissingPlugin')).rejects.toMatchObject({
			code: 'plugin_not_found',
		})
		await project[Symbol.asyncDispose]()
		await project[Symbol.asyncDispose]()
		await expect(project.plugins()).rejects.toMatchObject({ code: 'project_closed' })
	})

	it('captures query inputs before admission so later caller edits cannot alter validation or scope', async () => {
		const { root } = await fixture()
		await using project = await openProject({ root })
		const options = { packageName: '@fixture/mail', limit: 1 }
		const pending = project.plugins(options)
		options.packageName = '@fixture/missing'
		options.limit = 201
		const result = await pending
		expect(available(result.data).items).toHaveLength(1)

		const include: ('config' | 'parts')[] = ['config']
		const partPath = ['backup']
		const pendingPlugin = project.plugin(mailReference, { include, partPath })
		include[0] = 'parts'
		partPath[0] = 'missing'
		const plugin = await pendingPlugin
		expect(Object.keys(plugin.data.sections)).toEqual(['config'])
		const config = plugin.data.sections.config
		if (!config) throw new Error('Expected the config section selected at admission')
		expect(available(config).declarations[0]!.partPath).toEqual(['backup'])
	})

	it('types section presence according to literal, dynamic, optional and omitted include inputs', async () => {
		const { root } = await fixture()
		await using project = await openProject({ root })
		type ConfigSection = InspectionSection<InspectionSectionData['config']>
		type PartsSection = InspectionSection<InspectionSectionData['parts']>

		const literal = await project.plugin(mailReference, { include: ['config'] })
		expectTypeOf(literal.data.sections.config).toEqualTypeOf<ConfigSection>()
		expectTypeOf<keyof typeof literal.data.sections>().toEqualTypeOf<'config'>()

		const include: ('config' | 'parts')[] = ['config']
		const dynamic = await project.plugin(mailReference, { include })
		expectTypeOf(dynamic.data.sections.config).toEqualTypeOf<ConfigSection | undefined>()
		expectTypeOf(dynamic.data.sections.parts).toEqualTypeOf<PartsSection | undefined>()
		expect(Object.keys(dynamic.data.sections)).toEqual(['config'])

		const optionalOptions: { include?: readonly ['config'] } = {}
		const optional = await project.plugin(mailReference, optionalOptions)
		expectTypeOf(optional.data.sections.config).toEqualTypeOf<ConfigSection | undefined>()
		expect(optional.data.sections).toEqual({})

		const omitted = await project.plugin(mailReference)
		expectTypeOf<keyof typeof omitted.data.sections>().toEqualTypeOf<never>()
		expect(omitted.data.sections).toEqual({})
	})

	it('rejects sparse section and Part path arrays as invalid query inputs', async () => {
		const { root } = await fixture()
		await using project = await openProject({ root })
		await expect(
			project.plugin(mailReference, { partPath: Array<string>(1) }),
		).rejects.toMatchObject({ code: 'invalid_input' })
		await expect(
			project.plugin(mailReference, { include: Array<'config'>(1) }),
		).rejects.toMatchObject({ code: 'invalid_input' })
	})
})
