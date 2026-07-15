import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import fs from 'node:fs'
import { parsePackageIdentity, parsePackageName, resolveScaffoldIdentity } from '../src/scaffold'
import { generateFromTemplate } from '../src/scaffold/template'
import { formatPackageScriptCommand } from '../src/utils/pm'

describe('scaffold name helpers', () => {
	it('prefixes bare package names with the first plugin prefix', () => {
		const result = parsePackageName('foo', ['pluxel-plugin'])
		expect(result.name).toBe('foo')
		expect(result.packageName).toBe('pluxel-plugin-foo')
	})

	it('keeps scoped names and applies prefix to the scoped segment', () => {
		const result = parsePackageName('@acme/foo', ['pluxel-plugin'])
		expect(result.name).toBe('foo')
		expect(result.packageName).toBe('@acme/pluxel-plugin-foo')
	})

	it('detects already prefixed names and avoids duplicates', () => {
		const result = parsePackageName('pluxel-plugin-bar', ['pluxel-plugin'])
		expect(result.name).toBe('bar')
		expect(result.packageName).toBe('pluxel-plugin-bar')
	})

	it('respects any configured prefix when matching existing names', () => {
		const result = parsePackageName('acme-plugin-extra', ['pluxel-plugin', 'acme-plugin'])
		expect(result.name).toBe('extra')
		expect(result.packageName).toBe('acme-plugin-extra')
	})

	it('keeps application package identities free of plugin prefixes', () => {
		expect(parsePackageIdentity('@acme/my-app')).toEqual({
			scope: '@acme',
			name: 'my-app',
			packageName: '@acme/my-app',
		})
	})

	it('applies plugin prefixes only to the standalone plugin template', () => {
		expect(
			resolveScaffoldIdentity('@acme/pluxel-plugin-orders', '/templates/plugin', ['pluxel-plugin']),
		).toMatchObject({ name: 'orders', packageName: '@acme/pluxel-plugin-orders' })
		expect(
			resolveScaffoldIdentity('@acme/my-app', '/templates/app-monorepo', ['pluxel-plugin']),
		).toMatchObject({ name: 'my-app', packageName: '@acme/my-app' })
	})
})

describe('scaffold package-manager guidance', () => {
	it('prints a valid verify command for each supported package manager', () => {
		expect(formatPackageScriptCommand('pnpm', 'verify')).toBe('pnpm verify')
		expect(formatPackageScriptCommand('yarn', 'verify')).toBe('yarn verify')
		expect(formatPackageScriptCommand('npm', 'verify')).toBe('npm run verify')
		expect(formatPackageScriptCommand('bun', 'verify')).toBe('bun run verify')
	})
})

describe('scaffold template rendering', () => {
	it('keeps compiler semantics out of standalone plugin overrides', () => {
		const pluginBuild = fs.readFileSync(
			resolve(import.meta.dirname, '../templates/plugin/tsdown.config.ts.hbs'),
			'utf8',
		)
		expect(pluginBuild).not.toContain('removeClassFieldsWithoutInitializer')
		expect(pluginBuild).not.toContain('setPublicClassFields')
	})

	it('generates the plugin template with plugin-named entry files', async () => {
		await using fixture = await createFixture({
			template: {
				'package.json.hbs': JSON.stringify(
					{
						name: '{{packageName}}',
						description: '{{description}}',
					},
					null,
					2,
				),
				src: {
					'{{pluginName}}.ts.hbs': 'export class {{className}} {}\n',
				},
				tests: {
					'{{pluginName}}.test.ts.hbs': "export const name = '{{pluginName}}'\n",
				},
				'vitest.config.ts.hbs': 'export default {}\n',
				'static.txt': 'copied as-is\n',
				'prompts.jsonc': '[{ "name": "ignored", "message": "ignored" }]\n',
			},
		})
		const templateBase = resolve(fixture.path, 'template')

		const data = {
			pluginName: 'hello-world',
			packageName: 'pluxel-plugin-hello-world',
			className: 'HelloWorld',
			year: '2026',
			description: 'Test plugin',
		}

		const targetDir = resolve(fixture.path, data.pluginName)
		const ok = await generateFromTemplate(
			{
				templateBase,
				targetDir,
				data,
				force: false,
				dryRun: false,
				fs: fixture.fs as unknown as typeof fs,
			},
			() => {},
		)
		expect(ok).toBe(true)

		expect(fixture.fs.existsSync(resolve(targetDir, 'package.json'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'src', `${data.pluginName}.ts`))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'tests', `${data.pluginName}.test.ts`))).toBe(
			true,
		)
		expect(fixture.fs.existsSync(resolve(targetDir, 'vitest.config.ts'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'static.txt'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'prompts.jsonc'))).toBe(false)

		const entry = fixture.fs.readFileSync(
			resolve(targetDir, 'src', `${data.pluginName}.ts`),
			'utf8',
		)
		expect(entry).toContain(`export class ${data.className}`)
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
					description: 'Acme application',
				},
				force: false,
				dryRun: false,
				fs: fixture.fs as unknown as typeof fs,
			},
			() => {},
		)

		expect(ok).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'pnpm-workspace.yaml'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'web/src/pluxel.static.ts'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'web/tsdown.config.ts'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'apps'))).toBe(false)
		expect(fixture.fs.existsSync(resolve(targetDir, 'AGENTS.md'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'docs/pluxel/README.md'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'docs/pluxel/testing.md'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'user-docs.jsonc'))).toBe(false)

		const hostVite = fixture.fs.readFileSync(resolve(targetDir, 'web/vite.config.ts'), 'utf8')
		expect(hostVite).toContain("from '@pluxel/runtime-static/vite'")
		expect(hostVite).toContain("entry: './src/pluxel.static.ts'")
		expect(hostVite).not.toContain('../../packages/')
		const staticEntry = fixture.fs.readFileSync(
			resolve(targetDir, 'web/src/pluxel.static.ts'),
			'utf8',
		)
		expect(staticEntry).toContain('export default defineStaticRuntime({')
		const staticBuild = fixture.fs.readFileSync(resolve(targetDir, 'web/tsdown.config.ts'), 'utf8')
		expect(staticBuild).toContain("from '@pluxel/rolldown/build'")
		expect(staticBuild).toContain("entry: './src/pluxel.static.ts'")
		expect(staticBuild).toContain("variant: 'workbench'")

		const pluginManifest = fixture.fs.readFileSync(
			resolve(targetDir, 'plugins/example/package.json'),
			'utf8',
		)
		expect(pluginManifest).toContain('"@pluxel/runtime": "^0.3.0"')
		expect(pluginManifest).not.toContain('"@pluxel/runtime": "workspace:*"')

		const rootManifest = fixture.fs.readFileSync(resolve(targetDir, 'package.json'), 'utf8')
		expect(rootManifest).toContain('"@pluxel/rolldown": "^0.1.0"')
		expect(rootManifest).toContain('"oxfmt": "^0.57.0"')
		expect(rootManifest).not.toContain('"react":')
		expect(rootManifest).not.toContain('"@pluxel/core"')
		expect(rootManifest).not.toContain('"tsdown"')

		const webManifest = fixture.fs.readFileSync(resolve(targetDir, 'web/package.json'), 'utf8')
		expect(webManifest).toContain('"react": "^19.2.7"')
		expect(webManifest).toContain('"@gqlens/react": "0.2.0"')
		expect(fixture.fs.existsSync(resolve(targetDir, 'packages/web'))).toBe(false)
		expect(fixture.fs.existsSync(resolve(targetDir, 'web/src/client/main.tsx'))).toBe(true)

		const oxlintConfig = fixture.fs.readFileSync(resolve(targetDir, 'oxlint.config.ts'), 'utf8')
		expect(oxlintConfig).toContain("from '@pluxel/rolldown/oxlint'")
		expect(oxlintConfig).toContain('prefixPluxelRuleSet(pluxelRules)')

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

		const vitestConfig = fixture.fs.readFileSync(
			resolve(targetDir, 'plugins/example/vitest.config.ts'),
			'utf8',
		)
		expect(vitestConfig).toContain("from '@pluxel/test/vitest'")
		expect(vitestConfig).not.toContain('../test/src')

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
			fixture.fs.readFileSync(resolve(targetDir, 'package.json'), 'utf8'),
		) as Record<string, any>
		expect(manifest.scripts).not.toHaveProperty('build:plugin')
		expect(manifest.scripts.build).toBe('pluxel build')
		expect(manifest.scripts).toHaveProperty('verify')
		expect(manifest.peerDependencies).toEqual({ '@pluxel/runtime': '^0.3.0' })
		expect(manifest.exports['.']).toMatchObject({
			types: './dist/index.d.mts',
			'@pluxel/runtime-dynamic': './src/hello-world.ts',
			default: './dist/index.mjs',
		})
		expect(manifest.publishConfig.exports['.']).toEqual({
			types: './dist/index.d.mts',
			default: './dist/index.mjs',
		})
		expect(manifest.files).toEqual(['dist', '!**/*.map'])
		expect(manifest.devDependencies).toMatchObject({
			'@pluxel/cli': '^0.3.0',
			'@pluxel/core': '^0.3.0',
			'@pluxel/rolldown': '^0.1.0',
			'@pluxel/test': '^0.1.0',
			oxfmt: '^0.57.0',
		})
		expect(fixture.fs.existsSync(resolve(targetDir, 'oxlint.config.ts'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, '.oxfmtrc.json'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'AGENTS.md'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'docs/pluxel/plugin-package.md'))).toBe(true)
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
		const tsconfig = fixture.fs.readFileSync(resolve(targetDir, 'tsconfig.json'), 'utf8')
		expect(tsconfig).toContain('"src/**/*.tsx"')
		expect(tsconfig).toContain('"tests/**/*.tsx"')
		const tsdownConfig = fixture.fs.readFileSync(resolve(targetDir, 'tsdown.config.ts'), 'utf8')
		expect(tsdownConfig).toContain("index: 'src/hello-world.ts'")
		expect(tsdownConfig).not.toContain('pluginPackage(')
		const vitestConfig = fixture.fs.readFileSync(resolve(targetDir, 'vitest.config.ts'), 'utf8')
		expect(vitestConfig).not.toContain("'.*/**'")
		expect(vitestConfig).toContain('passWithNoTests: false')
		const readme = fixture.fs.readFileSync(resolve(targetDir, 'README.md'), 'utf8')
		expect(readme).toContain("import { HelloWorldPlugin } from 'pluxel-plugin-hello-world'")
	})
})
