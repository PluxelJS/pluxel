import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectOwnerConfigs } from '../src/inspect/config.ts'

const imported = `import { Plugin, PluginPart } from '@pluxel/core';`
const noResolve = async (): Promise<string | undefined> => undefined

describe('offline config locations', () => {
	it('finds repeated owner config declarations without evaluating schema factories', async () => {
		const code = `${imported}
const schema = (() => { throw new Error('must not execute') })();
@Plugin() export class Example { config = this.configs.use(schema); }
export class Retry extends PluginPart { settings = this.configs.use(customFactory()); }
`
		const report = await inspectOwnerConfigs([{ id: '/project/plugin.ts', code }], noResolve)
		expect(report.diagnostics).toEqual([])
		expect(report.declarations.map((item) => [item.className, item.fieldName])).toEqual([
			['Example', 'config'],
			['Retry', 'settings'],
		])
		const config = report.declarations[0]!
		expect(code.slice(config.start, config.end)).toBe('config = this.configs.use(schema);')
		expect(config.schema.expression).toBe('schema')
		expect(config.schema.inline).toBe(false)
		expect(config.schema.declaration?.symbol).toBe('schema')
		expect(report.declarations[1]!.schema.declaration).toBeUndefined()
		expect(report.declarations[1]!.schema.inline).toBe(true)
	})

	it('follows imported reexports and returns all observed source files', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-inspect-config-'))
		try {
			const id = join(root, 'plugin.ts')
			const code = `${imported}
import { Shared as schema } from './barrel.ts';
@Plugin() export class Example { config = this.configs.use(schema); }`
			await writeFile(join(root, 'barrel.ts'), `export { Shared } from './schema.ts';`)
			await writeFile(
				join(root, 'schema.ts'),
				`throw new Error('not executed'); export const Shared = customSchema();`,
			)
			const report = await inspectOwnerConfigs([{ id, code }], async (source, importer) =>
				source.startsWith('.') ? resolve(importer, '..', source) : undefined,
			)
			expect(report.diagnostics).toEqual([])
			expect(report.files.map((file) => file.id)).toEqual([
				id,
				join(root, 'barrel.ts'),
				join(root, 'schema.ts'),
			])
			const location = report.declarations[0]!.schema.declaration!
			expect(location.moduleId).toBe(join(root, 'schema.ts'))
			const schemaSource = await readFile(location.moduleId, 'utf8')
			expect(schemaSource.slice(location.start, location.end)).toBe('customSchema()')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('retains expression location and a diagnostic for unresolved schema references', async () => {
		const code = `${imported} import { Missing } from 'unknown';
@Plugin() export class Example { config = this.configs.use(Missing); }`
		const report = await inspectOwnerConfigs([{ id: '/project/plugin.ts', code }], noResolve)
		expect(report.declarations[0]!.schema.expression).toBe('Missing')
		expect(report.declarations[0]!.schema.declaration).toBeUndefined()
		expect(report.diagnostics[0]!.code).toBe('config_schema_unresolved')
	})

	it.each([
		`@Plugin() export class Example { first = this.configs.use(schema); second = this.configs.use(schema); }`,
		`export class Unmarked { config = this.configs.use(schema); }`,
		`@Plugin() export class Example { #config = this.configs.use(schema); }`,
		`@Plugin() export class Example { config = this.configs.use(); }`,
	])('uses the shared compiler declaration validation: %s', async (body) => {
		const report = await inspectOwnerConfigs(
			[{ id: '/project/plugin.ts', code: imported + body }],
			noResolve,
		)
		expect(report.declarations).toEqual([])
		expect(report.diagnostics[0]!.code).toBe('config_declaration_invalid')
	})

	it('retains exact field and wrapped schema locations for a default export', async () => {
		const code = `${imported}
const schema = customFactory();
@Plugin() export default class Example { private settings = this.configs.use(schema satisfies unknown); }
`
		const report = await inspectOwnerConfigs([{ id: '/project/plugin.ts', code }], noResolve)
		expect(report.diagnostics).toEqual([])
		const config = report.declarations[0]!
		expect(code.slice(config.start, config.end)).toBe(
			'private settings = this.configs.use(schema satisfies unknown);',
		)
		expect(code.slice(config.schema.start, config.schema.end)).toBe('schema satisfies unknown')
		expect(config.schema.inline).toBe(false)
		expect(config.schema.declaration?.symbol).toBe('schema')
	})

	it('uses the caller source snapshot and propagates its failures', async () => {
		const id = '/project/plugin.ts'
		const code = `${imported} import { Schema } from './schema.ts';
@Plugin() export class Example { config = this.configs.use(Schema); }`
		const readIds: string[] = []
		const report = await inspectOwnerConfigs([{ id, code }], async () => '/project/schema.ts', {
			async readSource(fileId) {
				readIds.push(fileId)
				return 'export const Schema = customFactory();'
			},
		})
		expect(readIds).toEqual(['/project/schema.ts'])
		expect(report.diagnostics).toEqual([])
		expect(report.declarations[0]!.schema.declaration?.moduleId).toBe('/project/schema.ts')
		const failure = Object.assign(new Error('Source changed'), { code: 'source_changed' })
		await expect(
			inspectOwnerConfigs([{ id, code }], async () => '/project/schema.ts', {
				async readSource() {
					throw failure
				},
			}),
		).rejects.toBe(failure)
	})

	it('honors cancellation', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(inspectOwnerConfigs([], noResolve, { signal: controller.signal })).rejects.toThrow(
			'This operation was aborted',
		)
	})

	it('rejects oversized imported source before parsing rather than reporting missing schema', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-inspect-config-budget-'))
		try {
			const schema = join(root, 'schema.ts')
			await writeFile(schema, '')
			await truncate(schema, 33 * 1024 * 1024)
			const code = `${imported} import { Schema } from './schema.ts';
@Plugin() export class Example { config = this.configs.use(Schema); }`
			await expect(
				inspectOwnerConfigs([{ id: join(root, 'plugin.ts'), code }], async () => schema),
			).rejects.toMatchObject({
				code: 'analysis_unavailable',
				message: expect.stringContaining('budget exceeded'),
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
