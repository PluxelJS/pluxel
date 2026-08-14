import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
	parsePackageIdentity,
	parsePackageName,
	resolveBuiltInTemplatePackageManager,
	resolveScaffoldDestinationInput,
	resolveScaffoldIdentity,
} from '../src/scaffold'
import { generateFromTemplate, promptTemplateData } from '../src/scaffold/template'
import { formatPackageScriptCommand } from '../src/utils/pm'

describe('scaffold name helpers', () => {
	it('resolves plugin prefixes separately from normalized application identities', () => {
		expect(parsePackageName('foo', ['pluxel-plugin'])).toMatchObject({
			name: 'foo',
			packageName: 'pluxel-plugin-foo',
		})
		expect(parsePackageName('@acme/foo', ['pluxel-plugin'])).toMatchObject({
			name: 'foo',
			packageName: '@acme/pluxel-plugin-foo',
		})
		expect(parsePackageName('pluxel-plugin-bar', ['pluxel-plugin']).name).toBe('bar')
		expect(
			parsePackageName('acme-plugin-extra', ['pluxel-plugin', 'acme-plugin']).packageName,
		).toBe('acme-plugin-extra')
		expect(parsePackageIdentity('@Acme/My-App')).toEqual({
			scope: '@acme',
			name: 'my-app',
			packageName: '@acme/my-app',
		})
		expect(
			resolveScaffoldIdentity('@acme/pluxel-plugin-orders', '/templates/plugin', ['pluxel-plugin']),
		).toMatchObject({ name: 'orders', packageName: '@acme/pluxel-plugin-orders' })
		expect(
			resolveScaffoldIdentity('@acme/my-app', '/templates/app-monorepo', ['pluxel-plugin']),
		).toMatchObject({ name: 'my-app', packageName: '@acme/my-app' })
	})
})

describe('scaffold package-manager guidance', () => {
	it('validates destinations and emits built-in package-manager guidance', () => {
		expect(resolveScaffoldDestinationInput(undefined)).toBeUndefined()
		expect(resolveScaffoldDestinationInput([])).toBeUndefined()
		expect(resolveScaffoldDestinationInput(['apps'])).toBe('apps')
		expect(() => resolveScaffoldDestinationInput(['apps', 'extra'])).toThrow(
			'Expected at most one scaffold destination',
		)
		expect(resolveBuiltInTemplatePackageManager('/templates/app-monorepo', '/templates')).toBe(
			'pnpm',
		)
		expect(resolveBuiltInTemplatePackageManager('/templates/plugin', '/templates')).toBe('pnpm')
		expect(resolveBuiltInTemplatePackageManager('/templates/custom', '/templates')).toBeUndefined()
		expect(resolveBuiltInTemplatePackageManager('/custom/plugin', '/templates')).toBeUndefined()
		expect(formatPackageScriptCommand('pnpm', 'verify')).toBe('pnpm verify')
		expect(formatPackageScriptCommand('yarn', 'verify')).toBe('yarn verify')
		expect(formatPackageScriptCommand('npm', 'verify')).toBe('npm run verify')
		expect(formatPackageScriptCommand('bun', 'verify')).toBe('bun run verify')
	})
})

describe('scaffold template rendering', () => {
	it('uses explicit prompt defaults without opening a TTY prompt', async () => {
		await using fixture = await createFixture({
			template: {
				'prompts.jsonc': JSON.stringify([
					{
						name: 'description',
						message: 'Description for {{className}}',
						default: 'Plugin {{className}}',
					},
				]),
			},
		})
		await expect(
			promptTemplateData(
				resolve(fixture.path, 'template'),
				{ className: 'Orders' },
				{
					fs: fixture.fs as unknown as typeof fs,
				},
			),
		).resolves.toEqual({ description: 'Plugin Orders' })
	})

	it('rejects non-interactive prompts without an explicit default', async () => {
		await using fixture = await createFixture({
			template: {
				'prompts.jsonc': JSON.stringify([{ name: 'description', message: 'Description' }]),
			},
		})
		await expect(
			promptTemplateData(
				resolve(fixture.path, 'template'),
				{},
				{
					fs: fixture.fs as unknown as typeof fs,
				},
			),
		).rejects.toThrow('Non-interactive prompt "description" requires a string default')
	})

	it('generates a standalone application monorepo from public package entrypoints', async () => {
		await using fixture = await createFixture()
		const targetDir = resolve(fixture.path, 'acme-app')
		const ok = await generateFromTemplate(
			{
				templateBase: resolve(import.meta.dirname, '../templates/app-monorepo'),
				targetDir,
				data: {
					pluginName: 'acme-app',
					packageName: '@acme/acme-app',
					className: 'AcmeApp',
					year: '2026',
					description: 'Acme "application"\\workspace\nstarter',
				},
				force: false,
				dryRun: false,
				fs: fixture.fs as unknown as typeof fs,
			},
			() => {},
		)

		expect(ok).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'apps'))).toBe(false)
		expect(fixture.fs.existsSync(resolve(targetDir, 'user-docs.jsonc'))).toBe(false)

		const hostVite = fixture.fs.readFileSync(resolve(targetDir, 'web/vite.config.ts'), 'utf8')
		expect(hostVite).toContain("from '@pluxel/runtime-static/vite'")
		expect(hostVite).toContain("entry: './src/pluxel.static.ts'")
		expect(hostVite).not.toContain('../../packages/')
		const staticBuild = fixture.fs.readFileSync(resolve(targetDir, 'web/tsdown.config.ts'), 'utf8')
		expect(staticBuild).toContain("from '@pluxel/rolldown/build'")
		expect(staticBuild).toContain("entry: './src/pluxel.static.ts'")
		expect(staticBuild).toContain("variant: 'workbench'")

		const pluginManifest = fixture.fs.readFileSync(
			resolve(targetDir, 'plugins/example/package.json'),
			'utf8',
		)
		expect(pluginManifest).toContain('"@pluxel/runtime": "catalog:"')
		expect(pluginManifest).not.toContain('"@pluxel/runtime": "workspace:*"')

		const rootManifest = String(fixture.fs.readFileSync(resolve(targetDir, 'package.json'), 'utf8'))
		expect(JSON.parse(rootManifest)).toMatchObject({
			description: 'Acme "application"\\workspace\nstarter',
		})
		expect(rootManifest).toContain('"@pluxel/rolldown": "catalog:"')
		expect(rootManifest).toContain('"oxfmt": "catalog:"')
		expect(rootManifest).toContain('"turbo": "catalog:"')
		expect(rootManifest).not.toContain('"react":')
		expect(rootManifest).not.toContain('"@pluxel/core"')
		expect(rootManifest).not.toContain('"tsdown"')
		const turboConfig = fixture.fs.readFileSync(resolve(targetDir, 'turbo.json'), 'utf8')
		expect(turboConfig).toContain('"concurrency": "100%"')
		expect(turboConfig).toContain('"dependsOn": ["^build", "^typecheck"]')

		const webManifest = fixture.fs.readFileSync(resolve(targetDir, 'web/package.json'), 'utf8')
		expect(webManifest).toContain('"react": "catalog:"')
		expect(webManifest).toContain('"@gqlens/react": "catalog:"')
		const workspaceSource = String(
			fixture.fs.readFileSync(resolve(targetDir, 'pnpm-workspace.yaml'), 'utf8'),
		)
		expect(workspaceSource).toContain("'@pluxel/runtime': ^0.3.0")
		expect(parseYaml(workspaceSource)).toMatchObject({
			packages: ['web', 'packages/*', 'plugins/*', 'plugins/*/*'],
			catalog: { '@pluxel/runtime': '^0.3.0' },
		})
		expect(fixture.fs.existsSync(resolve(targetDir, 'packages/web'))).toBe(false)
		const rootTsconfig = JSON.parse(
			String(fixture.fs.readFileSync(resolve(targetDir, 'tsconfig.base.json'), 'utf8')),
		) as { compilerOptions?: { customConditions?: string[] } }
		expect(rootTsconfig.compilerOptions?.customConditions).toEqual(['@pluxel/hmr'])

		const agentsGuide = fixture.fs.readFileSync(resolve(targetDir, 'AGENTS.md'), 'utf8')
		expect(agentsGuide).toContain('docs/pluxel/README.md')

		const sourceDocsDir = resolve(import.meta.dirname, '../../../user-docs')
		const sourceDocs = fs.readdirSync(sourceDocsDir).sort()
		const generatedDocs = fixture.fs.readdirSync(resolve(targetDir, 'docs/pluxel')).sort()
		expect(generatedDocs).toEqual(sourceDocs)
		for (const file of sourceDocs) {
			expect(fixture.fs.readFileSync(resolve(targetDir, 'docs/pluxel', file), 'utf8')).toBe(
				fs.readFileSync(resolve(sourceDocsDir, file), 'utf8'),
			)
		}

		const pluginTest = fixture.fs.readFileSync(
			resolve(targetDir, 'plugins/example/tests/plugin.test.ts'),
			'utf8',
		)
		expect(pluginTest).toContain("from '@pluxel/runtime/test'")
		expect(pluginTest).toContain('withRuntimeHost(')
		expect(pluginTest).toContain('workbench: false')
	})

	it('generates a self-contained publishable plugin package', async () => {
		await using fixture = await createFixture()
		const targetDir = resolve(fixture.path, 'hello-world')
		const ok = await generateFromTemplate(
			{
				templateBase: resolve(import.meta.dirname, '../templates/plugin'),
				targetDir,
				data: {
					pluginName: 'hello-world',
					packageName: 'pluxel-plugin-hello-world',
					className: 'HelloWorld',
					year: '2026',
					description: 'Hello plugin',
				},
				force: false,
				dryRun: false,
				fs: fixture.fs as unknown as typeof fs,
			},
			() => {},
		)

		expect(ok).toBe(true)
		const manifest = JSON.parse(
			String(fixture.fs.readFileSync(resolve(targetDir, 'package.json'), 'utf8')),
		) as Record<string, any>
		expect(manifest.scripts).not.toHaveProperty('build:plugin')
		expect(manifest.scripts.build).toBe('pluxel build')
		expect(manifest.scripts).toHaveProperty('verify')
		expect(manifest.peerDependencies).toEqual({ '@pluxel/runtime': 'catalog:' })
		for (const field of ['main', 'module', 'types', 'exports', 'publishConfig']) {
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
			"'@pluxel/runtime': ^0.3.0",
		)
		expect(fixture.fs.existsSync(resolve(targetDir, 'user-docs.jsonc'))).toBe(false)
		expect(fixture.fs.existsSync(resolve(targetDir, 'tsconfig.test.json'))).toBe(false)
		const source = fixture.fs.readFileSync(resolve(targetDir, 'src/hello-world.ts'), 'utf8')
		expect(source).toContain('export class HelloWorldPlugin extends BasePlugin')
		expect(source).toContain("@Plugin({ name: 'HelloWorldPlugin' })")
		expect(source).not.toContain('export default')
		const pluginTest = fixture.fs.readFileSync(
			resolve(targetDir, 'tests/hello-world.test.ts'),
			'utf8',
		)
		expect(pluginTest).toContain('await host.commit()')
		expect(pluginTest).toContain('workbench: false')
		expect(pluginTest).not.toContain('host.start(')
		const tsconfigSource = String(
			fixture.fs.readFileSync(resolve(targetDir, 'tsconfig.json'), 'utf8'),
		)
		const tsconfig = JSON.parse(tsconfigSource) as {
			compilerOptions?: { customConditions?: string[] }
		}
		expect(tsconfig.compilerOptions?.customConditions).toEqual(['@pluxel/hmr'])
		const tsdownConfig = fixture.fs.readFileSync(resolve(targetDir, 'tsdown.config.ts'), 'utf8')
		expect(tsdownConfig).toContain("index: 'src/hello-world.ts'")
		expect(tsdownConfig).not.toContain('pluginPackage(')
	})
})
