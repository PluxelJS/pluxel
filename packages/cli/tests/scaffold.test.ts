import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
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
		await using fixture = await createFixture({})
		const templateBase = fileURLToPath(new URL('../templates/plugin', import.meta.url))

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
			},
			() => {},
		)
		expect(ok).toBe(true)

		expect(fs.existsSync(resolve(targetDir, 'package.json'))).toBe(true)
		expect(fs.existsSync(resolve(targetDir, 'src', `${data.pluginName}.ts`))).toBe(true)
		expect(fs.existsSync(resolve(targetDir, 'tests', `${data.pluginName}.test.ts`))).toBe(true)
		expect(fs.existsSync(resolve(targetDir, 'tsdown.config.ts'))).toBe(true)
		expect(fs.existsSync(resolve(targetDir, 'tsconfig.test.json'))).toBe(true)
		expect(fs.existsSync(resolve(targetDir, 'vitest.config.ts'))).toBe(true)
		expect(fs.existsSync(resolve(targetDir, 'prompts.jsonc'))).toBe(false)

		const entry = fs.readFileSync(resolve(targetDir, 'src', `${data.pluginName}.ts`), 'utf8')
		expect(entry).toContain(`export class ${data.className}`)
	})
})
