import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { buildNodeModule } from '../../src/vite/node-module.ts'

describe('buildNodeModule', () => {
	it('builds a loadable single-file Node ESM closure', async () => {
		await using fixture = await createFixture({
			'src/value.ts': 'export const value = 21\n',
			'src/task.ts':
				"import { value } from './value.ts'\nimport { basename } from 'node:path'\nexport const result = value * 2\nexport const file = basename('/a/b.txt')\n",
		})
		const outFile = `${fixture.path}/dist/task.mjs`
		await buildNodeModule({
			root: fixture.path,
			entryPath: `${fixture.path}/src/task.ts`,
			outFile,
		})
		const output = await readFile(outFile, 'utf8')
		expect(output).not.toContain('./value')
		const module = await import(`${pathToFileURL(outFile).href}?test=closure`)
		expect(module).toMatchObject({ result: 42, file: 'b.txt' })
	})

	it('rejects runtime value imports, browser styles, and nested declarations', async () => {
		await using fixture = await createFixture({
			'runtime.ts': "import { Context } from '@pluxel/runtime'\nexport { Context }\n",
			'style.ts': "import './theme.css'\nexport const ok = true\n",
			'theme.css': 'body {}',
			'nested.ts': "export const nested = defineNodeModule(import.meta.url, './other.ts')\n",
		})
		for (const [entry, message] of [
			['runtime.ts', 'value import'],
			['style.ts', 'CSS and browser style assets'],
			['nested.ts', 'nested Pluxel declarations'],
		] as const) {
			await expect(
				buildNodeModule({
					root: fixture.path,
					entryPath: `${fixture.path}/${entry}`,
					outFile: `${fixture.path}/dist/${entry}.mjs`,
				}),
			).rejects.toThrow(message)
		}
	})

	it('preserves a directly declared native package as the only non-builtin residual', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ private: true }),
			'plugin/package.json': JSON.stringify({ dependencies: { 'fake-native': '1.0.0' } }),
			'plugin/task.ts': "import native from 'fake-native'\nexport default () => native\n",
			'plugin/node_modules/fake-native/package.json': JSON.stringify({
				name: 'fake-native',
				version: '1.0.0',
				main: 'index.js',
				napi: { binaryName: 'fake' },
			}),
			'plugin/node_modules/fake-native/index.js': 'module.exports = 42\n',
		})
		const outFile = `${fixture.path}/dist/task.mjs`
		await buildNodeModule({
			root: fixture.path,
			entryPath: `${fixture.path}/plugin/task.ts`,
			outFile,
		})
		const output = await readFile(outFile, 'utf8')
		expect(output).toMatch(/from ["']fake-native["']/)
	})

	it('rejects an imported native package that is not a direct dependency', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ dependencies: {} }),
			'task.ts': "import native from 'fake-native'\nexport default () => native\n",
			'node_modules/fake-native/package.json': JSON.stringify({
				name: 'fake-native',
				version: '1.0.0',
				main: 'index.js',
				napi: { binaryName: 'fake' },
			}),
			'node_modules/fake-native/index.js': 'module.exports = 42\n',
		})
		await expect(
			buildNodeModule({
				root: fixture.path,
				entryPath: `${fixture.path}/task.ts`,
				outFile: `${fixture.path}/dist/task.mjs`,
			}),
		).rejects.toThrow('must be declared directly')
	})
})
