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
})
