import { createFixture } from 'fs-fixture'
import { symlink } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { inspectPluginPackage } from '../../src/rolldown/plugins/pluginSemanticsPlugin.ts'

const manifest = JSON.stringify({
	name: '@example/mail',
	exports: { '.': { '@pluxel/source': './src/index.ts' } },
})

describe('offline semantic package inspection', () => {
	it('preserves root identity and repeated mounts without evaluating code', async () => {
		await using fixture = await createFixture({
			'package.json': manifest,
			'src/index.ts': `throw new Error('must never evaluate'); export { Mail as MailPlugin } from './mail.ts'`,
			'src/mail.ts': `import { BasePlugin, Plugin } from '@pluxel/core'; import { Delivery } from './part.ts'; @Plugin() export class Mail extends BasePlugin { first = this.parts.use(Delivery); second = this.parts.use(Delivery) }`,
			'src/part.ts': `import { PluginPart, definePluginRef } from '@pluxel/core'; import { Database } from '@example/database'; import type { Logger } from '@example/logger'; const LoggerRef = definePluginRef<Logger>(); export class Delivery extends PluginPart { constructor(database: Database) { super() } init() { this.plugins.use(LoggerRef, logger => {}) } }`,
		})
		const result = await inspectPluginPackage({ packageJsonPath: `${fixture.path}/package.json` })
		expect(result.definitions).toHaveLength(1)
		expect(result.definitions[0]?.definition).toEqual({
			entry: { kind: 'package-root', packageName: '@example/mail' },
			exportName: 'MailPlugin',
		})
		const root = result.owners.find((owner) => owner.className === 'Mail')!
		expect(root.parts.map((part) => part.fieldName)).toEqual(['first', 'second'])
		expect(root.parts[0]?.target).toEqual(root.parts[1]?.target)
		const part = result.owners.find((owner) => owner.className === 'Delivery')!
		expect(part.requires.map((address) => address.exportName)).toEqual(['Database'])
		expect(part.optional.map((address) => address.exportName)).toEqual(['Logger'])
		expect(result.files.map((file) => file.id.replace(fixture.path, ''))).toEqual(
			expect.arrayContaining(['/package.json', '/src/index.ts', '/src/mail.ts', '/src/part.ts']),
		)
		const source = result.files.find((file) => file.id.endsWith('/mail.ts'))!.code
		expect(source.slice(root.parts[0]!.start, root.parts[0]!.end)).toBe('this.parts.use(Delivery)')
	})
	it('retains compiler rejection for duplicate root names', async () => {
		await using fixture = await createFixture({
			'package.json': manifest,
			'src/index.ts': `import { BasePlugin, Plugin } from '@pluxel/core'; @Plugin() class Mail extends BasePlugin {} export { Mail, Mail as Other }`,
		})
		await expect(
			inspectPluginPackage({ packageJsonPath: `${fixture.path}/package.json` }),
		).rejects.toThrow('multiple root names')
	})
	it('keeps source evidence for ordinary libraries with no Plugins', async () => {
		await using fixture = await createFixture({
			'package.json': manifest,
			'src/index.ts': `export const version = 1`,
		})
		const result = await inspectPluginPackage({ packageJsonPath: `${fixture.path}/package.json` })
		expect(result.definitions).toEqual([])
		expect(result.rootEntry).toBe(`${fixture.path}/src/index.ts`)
		expect(result.files.some((file) => file.id.endsWith('/src/index.ts'))).toBe(true)
	})
	it('reports UTF-16 source ranges and canonical physical paths through symlinks', async () => {
		await using fixture = await createFixture({
			'package.json': manifest,
			'src/index.ts': `// 中文 😀
import { BasePlugin, Plugin } from '@pluxel/core'; import { Part } from './linked.ts'; @Plugin() export class Mail extends BasePlugin { delivery = this.parts.use(Part) }`,
			'src/physical.ts': `import { PluginPart } from '@pluxel/core'; export class Part extends PluginPart {}`,
		})
		await symlink(`${fixture.path}/src/physical.ts`, `${fixture.path}/src/linked.ts`)
		await symlink(`${fixture.path}/package.json`, `${fixture.path}/linked-package.json`)
		const result = await inspectPluginPackage({
			packageJsonPath: `${fixture.path}/linked-package.json`,
		})
		const owner = result.owners.find((item) => item.className === 'Mail')!
		const source = result.files.find((item) => item.id === owner.moduleId)!.code
		expect(source.slice(owner.parts[0]!.start, owner.parts[0]!.end)).toBe('this.parts.use(Part)')
		expect(owner.parts[0]!.start).toBe(source.indexOf('this.parts.use'))
		expect(owner.parts[0]!.target?.moduleId).toBe(`${fixture.path}/src/physical.ts`)
		expect(result.owners.find((item) => item.className === 'Part')!.moduleId).toBe(
			`${fixture.path}/src/physical.ts`,
		)
		expect(result.files.some((item) => item.id.endsWith('/linked.ts'))).toBe(false)
	})
	it('rejects source input budgets before parsing a large entry', async () => {
		await using fixture = await createFixture({
			'package.json': manifest,
			'src/index.ts': `/*${'x'.repeat(8192)}*/ export const value = 1`,
		})
		await expect(
			inspectPluginPackage({
				packageJsonPath: `${fixture.path}/package.json`,
				maxSourceBytes: 1024,
			}),
		).rejects.toThrow('source byte budget exceeded')
		await expect(
			inspectPluginPackage({ packageJsonPath: `${fixture.path}/package.json`, maxFiles: 1 }),
		).rejects.toThrow('source file budget exceeded')
	})
	it.each([
		'export abstract class AbstractThing {}',
		"import { BasePlugin } from '@pluxel/core'; export abstract class AbstractPlugin extends BasePlugin {}",
	])('does not turn abstract-only source libraries into Plugin packages: %s', async (source) => {
		await using fixture = await createFixture({ 'package.json': manifest, 'src/index.ts': source })
		const result = await inspectPluginPackage({ packageJsonPath: `${fixture.path}/package.json` })
		expect(result.definitions).toEqual([])
		expect(result.owners).toEqual([])
		expect(result.rootEntry).toBe(`${fixture.path}/src/index.ts`)
		expect(result.files.some((file) => file.id.endsWith('/src/index.ts'))).toBe(true)
	})
})
