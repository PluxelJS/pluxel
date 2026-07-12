import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import type fs from 'node:fs'
import { parsePackageName } from '../src/scaffold'
import { generateFromTemplate } from '../src/scaffold/template'

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
		expect(result.name).toBe('pluxel-plugin-bar')
		expect(result.packageName).toBe('pluxel-plugin-bar')
	})

	it('respects any configured prefix when matching existing names', () => {
		const result = parsePackageName('acme-plugin-extra', ['pluxel-plugin', 'acme-plugin'])
		expect(result.packageName).toBe('acme-plugin-extra')
	})
})

describe('scaffold template rendering', () => {
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
		expect(fixture.fs.existsSync(resolve(targetDir, 'apps'))).toBe(false)
		expect(fixture.fs.existsSync(resolve(targetDir, 'AGENTS.md'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'docs/PLUXEL_PLUGIN_GUIDE.md'))).toBe(true)

		const hostVite = fixture.fs.readFileSync(resolve(targetDir, 'web/vite.config.ts'), 'utf8')
		expect(hostVite).toContain("from '@pluxel/runtime-static/vite'")
		expect(hostVite).not.toContain('../../packages/')

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
		expect(agentsGuide).toContain('docs/PLUXEL_PLUGIN_GUIDE.md')

		const pluginGuide = fixture.fs.readFileSync(
			resolve(targetDir, 'docs/PLUXEL_PLUGIN_GUIDE.md'),
			'utf8',
		)
		expect(pluginGuide).toContain('required plugin dependencies belong in constructors')
		expect(pluginGuide).toContain('plugin-constructor-no-type-only-imports')
		expect(pluginGuide).toContain('runtime-type-augmentations')
		expect(pluginGuide).toContain('pnpm verify')

		const vitestConfig = fixture.fs.readFileSync(
			resolve(targetDir, 'plugins/example/vitest.config.ts'),
			'utf8',
		)
		expect(vitestConfig).toContain("from '@pluxel/test/vitest'")
		expect(vitestConfig).not.toContain('../test/src')
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
		expect(manifest.scripts).toHaveProperty('verify')
		expect(manifest.peerDependencies).toEqual({ '@pluxel/runtime': '^0.3.0' })
		expect(manifest.devDependencies).toMatchObject({
			'@pluxel/cli': '^0.3.0',
			'@pluxel/core': '^0.3.0',
			'@pluxel/rolldown': '^0.1.0',
			'@pluxel/test': '^0.1.0',
			oxfmt: '^0.57.0',
		})
		expect(fixture.fs.existsSync(resolve(targetDir, 'oxlint.config.ts'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, '.oxfmtrc.json'))).toBe(true)
		expect(fixture.fs.existsSync(resolve(targetDir, 'tsconfig.test.json'))).toBe(false)
		const vitestConfig = fixture.fs.readFileSync(resolve(targetDir, 'vitest.config.ts'), 'utf8')
		expect(vitestConfig).not.toContain("'.*/**'")
	})
})
