import { describe, expect, it, onTestFinished } from 'vitest'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'
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
import { resolveWorkspaceRoot } from '../src/scaffold/workspace'

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
	it('validates destinations and source syntax', () => {
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

describe('scaffold installation', () => {
	it('installs the bundled plugin through Vite+ with its exact pin and prints project tasks', async () => {
		const { root, result, calls } = await runScaffold(['--name', '@acme/orders'])
		expect(result).toMatchObject({ code: 0, stderr: '' })
		const manifest = JSON.parse(fs.readFileSync(resolve(root, 'orders/package.json'), 'utf8'))
		expect(calls()).toEqual([
			{ args: ['install'], cwd: resolve(root, 'orders'), manager: manifest.packageManager },
		])
		expect(result.stdout).toContain('vp run setup')
		expect(result.stdout).toContain('vp run verify')
	})

	it('preserves an explicit local template package-manager version through Vite+', async () => {
		const { root, result, calls } = await runScaffold(
			['--name', 'orders', '--template', './custom', '--pm', 'npm', '--install'],
			{
				'custom/pluxel-template.jsonc': JSON.stringify({ schemaVersion: 1, id: 'custom' }),
				'custom/package.json': JSON.stringify({ packageManager: 'npm@11.16.0' }),
			},
		)
		expect(result).toMatchObject({ code: 0, stderr: '' })
		expect(calls()).toEqual([
			{ args: ['install'], cwd: resolve(root, 'orders'), manager: 'npm@11.16.0' },
		])
		expect(result.stdout).toContain('vp run')
		expect(result.stdout).not.toContain('vp run setup')
	})

	it('retains generated files and reports a failed Vite+ installation', async () => {
		const { root, result } = await runScaffold(['--name', 'orders'], {}, 9)
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('Generated files remain in place')
		expect(fs.existsSync(resolve(root, 'orders/package.json'))).toBe(true)
		expect(result.stdout).not.toContain('vp run verify')
	})
})

async function runScaffold(args: string[], files: Record<string, string> = {}, installCode = 0) {
	const root = fs.mkdtempSync(resolve(tmpdir(), 'pluxel-scaffold-install-'))
	onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
	for (const [path, contents] of Object.entries(files)) {
		const target = resolve(root, path)
		fs.mkdirSync(resolve(target, '..'), { recursive: true })
		fs.writeFileSync(target, contents)
	}
	const tools = resolve(root, 'tools')
	fs.mkdirSync(tools)
	const callPath = resolve(root, 'vp-calls.jsonl')
	fs.writeFileSync(callPath, '')
	fs.writeFileSync(
		resolve(tools, 'vp'),
		`#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(callPath)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), manager: process.env.VP_PACKAGE_MANAGER}) + '\\n')
process.exitCode = ${installCode}
`,
		{ mode: 0o700 },
	)
	fs.writeFileSync(resolve(tools, 'pnpm'), `#!${process.execPath}\nprocess.exit(99)\n`, {
		mode: 0o700,
	})
	const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(accept, reject) => {
			const child = spawn(
				process.execPath,
				[resolve(import.meta.dirname, '../bin/pluxel.mjs'), 'new', ...args],
				{
					cwd: root,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` },
				},
			)
			let stdout = ''
			let stderr = ''
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
			child.once('error', reject)
			child.once('close', (code) => accept({ code, stdout, stderr }))
		},
	)
	return {
		root,
		result,
		calls: () =>
			fs
				.readFileSync(callPath, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	}
}

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
		expect(manifest.name).toBe('pluxel-plugin-hello-world')
		const repositoryManifest = JSON.parse(
			fs.readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8'),
		)
		expect(manifest.packageManager).toBe(repositoryManifest.packageManager)
		expect(manifest.scripts.build).toBe('vp run compile')
		expect(manifest.scripts['hooks:install']).toBe('hk install')
		for (const name of [
			'vite.config.ts',
			'oxlint.config.ts',
			'oxfmt.config.ts',
			'mise.toml',
			'hk.pkl',
			'pnpm-workspace.yaml',
			'src/hello-world.ts',
			'tests/hello-world.test.ts',
			'tsconfig.json',
			'tsdown.config.ts',
		]) {
			expect(fixture.fs.existsSync(resolve(targetDir, name))).toBe(true)
		}
		expect(manifest.peerDependencies).toEqual({
			'@pluxel/core': 'catalog:',
			'@pluxel/host': 'catalog:',
		})
		expect(manifest.peerDependenciesMeta).toEqual({ '@pluxel/host': { optional: true } })
		expect(manifest.dependencies).toEqual({ valibot: 'catalog:' })
		expect(manifest.exports).toEqual({
			'.': {
				'@pluxel/hmr': './src/hello-world.ts',
				default: './dist/index.mjs',
			},
		})
		expect(manifest.files).toEqual(['dist', '!**/*.map'])
		expect(manifest.devDependencies).toMatchObject({
			'@pluxel/agent-sdk': 'catalog:',
			'@pluxel/cli': 'catalog:',
			'@pluxel/core': 'catalog:',
			'@pluxel/host': 'catalog:',
			'@pluxel/rolldown': 'catalog:',
			'@pluxel/test': 'catalog:',
			'vite-plus': 'catalog:',
		})
		expect(manifest.engines).toEqual({ node: '>=24' })
	})
})

it('finds the pnpm workspace above a package-owned Vite configuration', () => {
	const root = fs.mkdtempSync(resolve(tmpdir(), 'pluxel-scaffold-root-'))
	onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
	fs.writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n')
	const leaf = resolve(root, 'packages/app')
	fs.mkdirSync(leaf, { recursive: true })
	fs.writeFileSync(resolve(leaf, 'package.json'), JSON.stringify({ name: '@example/app' }))
	fs.writeFileSync(resolve(leaf, 'vite.config.ts'), 'export default {}\n')
	expect(resolveWorkspaceRoot(leaf)).toEqual({ root, reason: 'pnpm-workspace' })
})
