import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import fs from 'node:fs'
import {
	createCommandPlan,
	parsePackageName,
	resolveScaffoldDestinationInput,
} from '../src/scaffold'
import { loadTemplateContract, validateTemplateContract } from '../src/scaffold/contract'
import { materializeScaffoldPlan } from '../src/scaffold/materialize'
import { authorizePlanOverwrite, compileScaffoldPlan } from '../src/scaffold/plan'
import { collectTemplateAnswers } from '../src/scaffold/prompts'
import { renderTemplateValue } from '../src/scaffold/render'
import { parseTemplateSource } from '../src/scaffold/source'
import { formatPackageScriptCommand } from '../src/utils/pm'

async function generateTemplate(params: {
	templateBase: string
	targetDir: string
	data: Record<string, string>
	force?: boolean
	fs: typeof fs
}) {
	const contract = await loadTemplateContract(params.templateBase, { fs: params.fs })
	const plan = await compileScaffoldPlan({
		templateRoot: params.templateBase,
		template: { kind: 'local', path: params.templateBase },
		contract,
		targetDir: params.targetDir,
		data: params.data,
		force: params.force ?? false,
		install: false,
		fs: params.fs,
	})
	await materializeScaffoldPlan(plan, () => {}, { fs: params.fs })
	return plan
}

describe('scaffold name helpers', () => {
	it('always applies the plugin package convention', () => {
		expect(parsePackageName('foo')).toMatchObject({
			name: 'foo',
			packageName: 'pluxel-plugin-foo',
		})
		expect(parsePackageName('@acme/foo')).toMatchObject({
			name: 'foo',
			packageName: '@acme/pluxel-plugin-foo',
		})
		expect(parsePackageName('pluxel-plugin-bar').name).toBe('bar')
	})
})

describe('scaffold command inputs', () => {
	it('validates destinations, source syntax, and package-manager guidance', () => {
		expect(resolveScaffoldDestinationInput(undefined)).toBeUndefined()
		expect(resolveScaffoldDestinationInput([])).toBeUndefined()
		expect(resolveScaffoldDestinationInput(['apps'])).toBe('apps')
		expect(() => resolveScaffoldDestinationInput(['apps', 'extra'])).toThrow(
			'Expected at most one scaffold destination',
		)
		expect(parseTemplateSource('plugin')).toEqual({ kind: 'bundled', name: 'plugin' })
		expect(parseTemplateSource('./templates/custom', { cwd: '/workspace' })).toEqual({
			kind: 'local',
			path: '/workspace/templates/custom',
		})
		expect(parseTemplateSource('.\\templates\\custom', { cwd: '/workspace' })).toEqual({
			kind: 'local',
			path: '/workspace/templates/custom',
		})
		expect(() => parseTemplateSource('gh:acme/template')).toThrow('Unsupported template source')
		expect(formatPackageScriptCommand('pnpm', 'verify')).toBe('pnpm verify')
		expect(formatPackageScriptCommand('yarn', 'verify')).toBe('yarn verify')
		expect(formatPackageScriptCommand('npm', 'verify')).toBe('npm run verify')
		expect(formatPackageScriptCommand('bun', 'verify')).toBe('bun run verify')
	})

	it('derives install trust defaults after resolving template provenance', () => {
		const contract = validateTemplateContract({
			schemaVersion: 1,
			id: 'plugin',
			packageManager: { name: 'pnpm' },
		})
		const values = { force: false, 'dry-run': false } as Parameters<typeof createCommandPlan>[3]
		const bundled = createCommandPlan(
			'orders',
			{
				root: '/templates/plugin',
				provenance: { kind: 'bundled', name: 'plugin' },
				async dispose() {},
			},
			contract,
			values,
			{ cwd: '/workspace' },
		)
		const local = createCommandPlan(
			'orders',
			{
				root: '/templates/plugin',
				provenance: { kind: 'local', path: '/templates/plugin' },
				async dispose() {},
			},
			contract,
			values,
			{ cwd: '/workspace' },
		)
		expect(bundled).toMatchObject({ install: true, packageManager: 'pnpm' })
		expect(local).toMatchObject({ install: false, packageManager: 'pnpm' })
		expect(
			createCommandPlan(
				'orders',
				{
					root: '/templates/plugin',
					provenance: { kind: 'local', path: '/templates/plugin' },
					async dispose() {},
				},
				contract,
				{ ...values, install: true },
				{ cwd: '/workspace' },
			),
		).toMatchObject({ install: true })
	})
})

describe('scaffold template rendering', () => {
	it('strictly validates manifests and rejects legacy template contracts', async () => {
		expect(() =>
			validateTemplateContract({
				schemaVersion: 1,
				id: 'fixture',
				prompts: [],
				prompt: [],
			}),
		).toThrow('unknown field: prompt')
		expect(() =>
			validateTemplateContract({
				schemaVersion: 2,
				id: 'fixture',
			}),
		).toThrow('TEMPLATE_SCHEMA_UNSUPPORTED')
		expect(() =>
			validateTemplateContract({
				schemaVersion: 1,
				id: 'fixture',
				prompts: [
					{
						name: 'release-channel',
						type: 'text',
						message: 'Release channel',
						default: 'stable',
					},
				],
			}),
		).toThrow('must be a template variable identifier')

		await using fixture = await createFixture({
			template: {
				'pluxel-template.jsonc': JSON.stringify({
					schemaVersion: 1,
					id: 'fixture',
				}),
				'README.md.hbs': '# {{ packageName }}',
			},
		})
		const templateRoot = resolve(fixture.path, 'template')
		const contract = await loadTemplateContract(templateRoot, {
			fs: fixture.fs as unknown as typeof fs,
		})
		await expect(
			compileScaffoldPlan({
				templateRoot,
				template: { kind: 'local', path: templateRoot },
				contract,
				targetDir: resolve(fixture.path, 'output'),
				data: { packageName: '@acme/orders' },
				force: false,
				install: false,
				fs: fixture.fs as unknown as typeof fs,
			}),
		).rejects.toThrow('Legacy template file is not supported')
	})

	it('uses explicit prompt defaults without opening a TTY prompt', async () => {
		const contract = validateTemplateContract({
			schemaVersion: 1,
			id: 'fixture',
			prompts: [
				{
					name: 'description',
					type: 'text',
					message: 'Description for {{ className }}',
					default: 'Plugin {{ className }}',
				},
			],
		})
		await expect(
			collectTemplateAnswers(contract, { className: 'Orders' }, { interactive: false }),
		).resolves.toEqual({ description: 'Plugin Orders' })
	})

	it('rejects non-interactive prompts without an explicit default', async () => {
		const contract = validateTemplateContract({
			schemaVersion: 1,
			id: 'fixture',
			prompts: [{ name: 'description', type: 'text', message: 'Description' }],
		})
		await expect(collectTemplateAnswers(contract, {}, { interactive: false })).rejects.toThrow(
			'Non-interactive prompt "description" requires a default',
		)
	})

	it('uses only strict variables and the json helper', () => {
		expect(
			renderTemplateValue(
				'{{ packageName }}: {{ json description }}',
				{
					packageName: '@acme/orders',
					description: 'say "hello"',
				},
				'fixture',
			),
		).toBe('@acme/orders: "say \\"hello\\""')
		expect(() =>
			renderTemplateValue('{{ pascalCase name }}', { name: 'orders' }, 'fixture'),
		).toThrow('Unknown template helper')
		expect(() => renderTemplateValue('{{ missing }}', {}, 'fixture')).toThrow(
			'Unknown template key',
		)
		expect(() => renderTemplateValue('{{ missing', {}, 'fixture')).toThrow(
			'Unclosed template token',
		)
	})

	it('materializes the byte snapshot captured by the plan', async () => {
		await using fixture = await createFixture({
			template: {
				'pluxel-template.jsonc': JSON.stringify({
					schemaVersion: 1,
					id: 'fixture',
				}),
				'README.md.tpl': '# {{ packageName }}',
				'logo.bin': Buffer.from([0, 1, 2, 255]),
			},
		})
		const templateRoot = resolve(fixture.path, 'template')
		const targetDir = resolve(fixture.path, 'output')
		const contract = await loadTemplateContract(templateRoot, {
			fs: fixture.fs as unknown as typeof fs,
		})
		const plan = await compileScaffoldPlan({
			templateRoot,
			template: { kind: 'local', path: templateRoot },
			contract,
			targetDir,
			data: { packageName: '@acme/orders' },
			force: false,
			install: false,
			fs: fixture.fs as unknown as typeof fs,
		})
		fixture.fs.writeFileSync(resolve(templateRoot, 'README.md.tpl'), '# changed', 'utf8')
		await materializeScaffoldPlan(plan, () => {}, {
			fs: fixture.fs as unknown as typeof fs,
		})
		expect(fixture.fs.readFileSync(resolve(targetDir, 'README.md'), 'utf8')).toBe('# @acme/orders')
		expect([...fixture.fs.readFileSync(resolve(targetDir, 'logo.bin'))]).toEqual([0, 1, 2, 255])
	})

	it('requires exact overwrite authorization and rejects rendered collisions', async () => {
		await using fixture = await createFixture({
			template: {
				'pluxel-template.jsonc': JSON.stringify({
					schemaVersion: 1,
					id: 'fixture',
				}),
				'{{ first }}.tpl': 'first',
				'{{ second }}.tpl': 'second',
			},
		})
		const templateRoot = resolve(fixture.path, 'template')
		const contract = await loadTemplateContract(templateRoot, {
			fs: fixture.fs as unknown as typeof fs,
		})
		await expect(
			compileScaffoldPlan({
				templateRoot,
				template: { kind: 'local', path: templateRoot },
				contract,
				targetDir: resolve(fixture.path, 'output'),
				data: { first: 'same.txt', second: 'same.txt' },
				force: false,
				install: false,
				fs: fixture.fs as unknown as typeof fs,
			}),
		).rejects.toThrow('TEMPLATE_OUTPUT_CONFLICT')

		fixture.fs.rmSync(resolve(templateRoot, '{{ second }}.tpl'))
		await expect(
			compileScaffoldPlan({
				templateRoot,
				template: { kind: 'local', path: templateRoot },
				contract,
				targetDir: resolve(fixture.path, 'output'),
				data: { first: '../escape' },
				force: false,
				install: false,
				fs: fixture.fs as unknown as typeof fs,
			}),
		).rejects.toThrow('Invalid output path')
		fixture.fs.mkdirSync(resolve(fixture.path, 'output'), { recursive: true })
		fixture.fs.writeFileSync(resolve(fixture.path, 'output/same.txt'), 'existing', 'utf8')
		const plan = await compileScaffoldPlan({
			templateRoot,
			template: { kind: 'local', path: templateRoot },
			contract,
			targetDir: resolve(fixture.path, 'output'),
			data: { first: 'same.txt' },
			force: false,
			install: false,
			fs: fixture.fs as unknown as typeof fs,
		})
		await expect(
			materializeScaffoldPlan(plan, () => {}, { fs: fixture.fs as unknown as typeof fs }),
		).rejects.toThrow('Use --force')
		await materializeScaffoldPlan(authorizePlanOverwrite(plan), () => {}, {
			fs: fixture.fs as unknown as typeof fs,
		})
		expect(fixture.fs.readFileSync(resolve(fixture.path, 'output/same.txt'), 'utf8')).toBe('first')
	})

	it('generates a self-contained publishable plugin package', async () => {
		await using fixture = await createFixture()
		const targetDir = resolve(fixture.path, 'hello-world')
		const plan = await generateTemplate({
			templateBase: resolve(import.meta.dirname, '../templates/plugin'),
			targetDir,
			data: {
				pluginName: 'hello-world',
				packageName: 'pluxel-plugin-hello-world',
				className: 'HelloWorld',
				year: '2026',
				description: 'Hello plugin',
			},
			fs: fixture.fs as unknown as typeof fs,
		})

		expect(plan.outputs.length).toBeGreaterThan(0)
		const manifest = JSON.parse(
			String(fixture.fs.readFileSync(resolve(targetDir, 'package.json'), 'utf8')),
		) as Record<string, any>
		expect(manifest.scripts).not.toHaveProperty('build:plugin')
		expect(manifest.scripts.build).toBe('pluxel build')
		expect(manifest.scripts).toHaveProperty('verify')
		expect(manifest.peerDependencies).toEqual({ '@pluxel/runtime': 'catalog:' })
		expect(manifest.exports).toEqual({
			'.': {
				'@pluxel/hmr': './src/hello-world.ts',
				default: './dist/index.mjs',
			},
		})
		for (const field of ['main', 'module', 'types', 'publishConfig']) {
			expect(manifest).not.toHaveProperty(field)
		}
		expect(manifest.files).toEqual(['dist', '!**/*.map'])
		expect(manifest.devDependencies).toMatchObject({
			'@pluxel/cli': 'catalog:',
			'@pluxel/core': 'catalog:',
			'@pluxel/rolldown': 'catalog:',
			'@pluxel/test': 'catalog:',
			oxfmt: 'catalog:',
		})
		expect(fixture.fs.readFileSync(resolve(targetDir, 'pnpm-workspace.yaml'), 'utf8')).toContain(
			"'@pluxel/runtime': ^1.0.0",
		)
		expect(fixture.fs.existsSync(resolve(targetDir, 'pluxel-docs.jsonc'))).toBe(false)
		expect(fixture.fs.existsSync(resolve(targetDir, 'tsconfig.test.json'))).toBe(false)
		const source = fixture.fs.readFileSync(resolve(targetDir, 'src/hello-world.ts'), 'utf8')
		expect(source).toContain('export class HelloWorldPlugin extends BasePlugin')
		expect(source).toContain('@Plugin()')
		expect(source).toContain('const MessageConfig = v.object({')
		const pluginTest = fixture.fs.readFileSync(
			resolve(targetDir, 'tests/hello-world.test.ts'),
			'utf8',
		)
		expect(pluginTest).toContain("from 'pluxel-plugin-hello-world'")
		expect(pluginTest).not.toContain("from '../src/")
		expect(source).not.toContain('export default')
		expect(pluginTest).toContain('await host.commit()')
		expect(pluginTest).toContain('workbench: false')
		expect(pluginTest).toContain('host.start(HelloWorldPlugin)')
		const tsconfigSource = String(
			fixture.fs.readFileSync(resolve(targetDir, 'tsconfig.json'), 'utf8'),
		)
		const tsconfig = JSON.parse(tsconfigSource) as {
			compilerOptions?: { customConditions?: string[]; emitDecoratorMetadata?: boolean }
		}
		expect(tsconfig.compilerOptions?.customConditions).toEqual(['@pluxel/hmr'])
		expect(tsconfig.compilerOptions?.emitDecoratorMetadata).toBeUndefined()
		const tsdownConfig = fixture.fs.readFileSync(resolve(targetDir, 'tsdown.config.ts'), 'utf8')
		expect(tsdownConfig).toContain("index: 'src/hello-world.ts'")
		expect(tsdownConfig).not.toContain('pluginPackage(')
	})
})
