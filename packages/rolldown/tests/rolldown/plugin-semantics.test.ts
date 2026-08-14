import { createFixture } from 'fs-fixture'
import { parseSync } from 'oxc-parser'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import {
	analyzePluginSemantics,
	createPluginSemanticsPlugin,
} from '../../src/rolldown/plugins/pluginSemanticsPlugin'

function parse(code: string) {
	return parseSync('src/consumer.ts', code, { sourceType: 'module', lang: 'ts' }).program
}

describe('plugin semantics', () => {
	it('collects only constructor and optional declaration dependencies', () => {
		const semantics = analyzePluginSemantics(
			parse(`
				import { BasePlugin, optionalPlugin, Plugin } from '@pluxel/runtime'
				import { DatabasePlugin } from 'pluxel-plugin-database'
				import { AuditContract } from '@acme/audit-contract'
				import 'pluxel-plugin-unrelated'
				const Audit = optionalPlugin(() =>
					import('pluxel-plugin-audit').then(({ AuditPlugin }) => AuditPlugin),
				)
				@Plugin({ name: 'Consumer' })
				class Consumer extends BasePlugin {
					constructor(readonly db: DatabasePlugin, readonly audit: AuditContract) { super() }
				}
				void import('pluxel-plugin-lazy-code')
			`),
		)

		expect(semantics.optionalPlugins).toMatchObject([
			{
				packageSpecifier: 'pluxel-plugin-audit',
				exportName: 'AuditPlugin',
				argumentCount: 1,
			},
		])
		expect(semantics.requiredPackages).toEqual(['pluxel-plugin-database', '@acme/audit-contract'])
	})

	it('lowers an unresolved optional package to an explicit absent chunk', async () => {
		await using fixture = await createFixture({
			'src/index.ts': [
				"import { optionalPlugin } from '@pluxel/runtime'",
				"export const Missing = optionalPlugin(() => import('pluxel-plugin-missing').then(({ MissingPlugin }) => MissingPlugin))",
				'',
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime'],
			plugins: [createPluginSemanticsPlugin().plugin],
		})
		const output = await build.generate({ format: 'esm' })
		const code = output.output
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')

		expect(code).toContain('PLUXEL_OPTIONAL_PLUGIN_ABSENT')
		expect(code).toContain('pluxel-plugin-missing')
		expect(code).not.toContain("import('pluxel-plugin-missing')")
	})

	it('keeps optional peers external in an independent plugin package', async () => {
		await using fixture = await createFixture({
			'node_modules/pluxel-plugin-present/package.json': JSON.stringify({
				name: 'pluxel-plugin-present',
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/pluxel-plugin-present/index.js':
				'export class PresentPlugin { static marker = "must-stay-external" }',
			'src/index.ts': [
				"import { optionalPlugin } from '@pluxel/runtime'",
				"export const Missing = optionalPlugin(() => import('pluxel-plugin-missing').then(({ MissingPlugin }) => MissingPlugin))",
				"export const Present = optionalPlugin(() => import('pluxel-plugin-present').then(({ PresentPlugin }) => PresentPlugin))",
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime'],
			plugins: [createPluginSemanticsPlugin({ optionalImportMode: 'external' }).plugin],
		})
		const output = await build.generate({ format: 'esm' })
		const code = output.output.find((item) => item.type === 'chunk')?.code ?? ''
		expect(code).toContain('import("pluxel-plugin-missing")')
		expect(code).toContain('import("pluxel-plugin-present")')
		expect(code).toContain('), "pluxel-plugin-missing")')
		expect(code).not.toContain('must-stay-external')
		expect(code).not.toContain('PLUXEL_OPTIONAL_PLUGIN_ABSENT')
	})

	it('keeps detected required plugin packages external on the first build', async () => {
		await using fixture = await createFixture({
			'node_modules/pluxel-plugin-required/package.json': JSON.stringify({
				name: 'pluxel-plugin-required',
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/pluxel-plugin-required/index.js':
				'export class RequiredPlugin { static marker = "must-stay-required-peer" }',
			'src/index.ts': [
				"import { BasePlugin, Plugin } from '@pluxel/runtime'",
				"import { RequiredPlugin } from 'pluxel-plugin-required'",
				"@Plugin({ name: 'ConsumerPlugin' })",
				'export class ConsumerPlugin extends BasePlugin {',
				'  static readonly Required = RequiredPlugin',
				'  constructor(readonly required: RequiredPlugin) { super() }',
				'}',
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime'],
			plugins: [
				createPluginSemanticsPlugin({
					prefixes: ['pluxel-plugin'],
					optionalImportMode: 'external',
				}).plugin,
			],
		})
		const output = await build.generate({ format: 'esm' })
		const code = output.output.find((item) => item.type === 'chunk')?.code ?? ''
		expect(code).toContain('from "pluxel-plugin-required"')
		expect(code).not.toContain('must-stay-required-peer')
	})

	it('accepts its internal package annotation on a later route build', async () => {
		await using fixture = await createFixture({
			'node_modules/pluxel-plugin-present/package.json': JSON.stringify({
				name: 'pluxel-plugin-present',
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/pluxel-plugin-present/index.js':
				'export class PresentPlugin { static marker = "annotated-candidate" }',
			'src/index.js': [
				"import { optionalPlugin } from '@pluxel/runtime'",
				"export const Present = optionalPlugin(() => import('pluxel-plugin-present').then(({ PresentPlugin }) => PresentPlugin), 'pluxel-plugin-present')",
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.js'),
			external: ['@pluxel/runtime'],
			plugins: [createPluginSemanticsPlugin().plugin],
		})
		const output = await build.generate({ format: 'esm' })
		const code = output.output
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')
		expect(code).toContain('annotated-candidate')
		expect(code).not.toContain('PLUXEL_OPTIONAL_PLUGIN_ABSENT')
	})

	it('lowers an absent candidate declared by an installed plugin package', async () => {
		await using fixture = await createFixture({
			'node_modules/pluxel-plugin-consumer/package.json': JSON.stringify({
				name: 'pluxel-plugin-consumer',
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/pluxel-plugin-consumer/index.js': [
				"import { optionalPlugin } from '@pluxel/runtime'",
				"export const Missing = optionalPlugin(() => import('pluxel-plugin-missing').then(({ MissingPlugin }) => MissingPlugin), 'pluxel-plugin-missing')",
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('node_modules/pluxel-plugin-consumer/index.js'),
			external: ['@pluxel/runtime'],
			plugins: [createPluginSemanticsPlugin().plugin],
		})
		const output = await build.generate({ format: 'esm' })
		const code = output.output
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')
		expect(code).toContain('PLUXEL_OPTIONAL_PLUGIN_ABSENT')
		expect(code).not.toContain('import("pluxel-plugin-missing")')
	})

	it('rejects inline declarations before bundling', async () => {
		await using fixture = await createFixture({
			'src/index.ts': [
				"import { optionalPlugin } from '@pluxel/runtime'",
				'export function load() {',
				"  return optionalPlugin(() => import('pluxel-plugin-missing').then(({ MissingPlugin }) => MissingPlugin))",
				'}',
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime'],
			plugins: [createPluginSemanticsPlugin().plugin],
		})
		await expect(build.generate({ format: 'esm' })).rejects.toThrow('module-level const')
	})

	it('keeps a resolvable candidate in the fixed bundle closure', async () => {
		await using fixture = await createFixture({
			'node_modules/pluxel-plugin-present/package.json': JSON.stringify({
				name: 'pluxel-plugin-present',
				type: 'module',
				exports: './index.js',
			}),
			'node_modules/pluxel-plugin-present/index.js':
				'export class PresentPlugin { static marker = "present-candidate" }',
			'src/index.ts': [
				"import { optionalPlugin } from '@pluxel/runtime'",
				"export const Present = optionalPlugin(() => import('pluxel-plugin-present').then(({ PresentPlugin }) => PresentPlugin))",
			].join('\n'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime'],
			plugins: [createPluginSemanticsPlugin().plugin],
		})
		const output = await build.generate({ format: 'esm' })
		const code = output.output
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')
		expect(code).toContain('present-candidate')
		expect(code).not.toContain('PLUXEL_OPTIONAL_PLUGIN_ABSENT')
	})
})
