import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import {
	buildNodeModule,
	resolveNodeModuleNativeResiduals,
} from '../../src/plugin-artifact/node-module.ts'

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
			'nested-workbench.ts': 'export const nested = workbench.define({})\n',
		})
		for (const [entry, message] of [
			['runtime.ts', 'value import'],
			['style.ts', 'CSS and browser style assets'],
			['nested.ts', 'nested Pluxel declarations'],
			['nested-workbench.ts', 'nested Pluxel declarations'],
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

	it('loads a directly declared native package through its owner boundary', async () => {
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
		expect(output).not.toMatch(/from ["']fake-native["']/)
		expect(output).toContain('fake-native')
		const module = await import(`${pathToFileURL(outFile).href}?test=direct-native`)
		expect(module.default()).toBe(42)
	})

	it('allows a bundled dependency to own its directly declared native residual', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ dependencies: { wrapper: '1.0.0' } }),
			'task.ts': "import { value } from 'wrapper'\nexport default () => value\n",
			'node_modules/wrapper/package.json': JSON.stringify({
				name: 'wrapper',
				version: '1.0.0',
				type: 'module',
				main: 'index.js',
				exports: { '.': { '@pluxel/hmr': './source.ts', default: './index.js' } },
				dependencies: { 'fake-native': '1.0.0' },
			}),
			'node_modules/wrapper/source.ts':
				"import { value as nativeValue } from 'fake-native'\nexport const value = nativeValue\n",
			'node_modules/wrapper/index.js': 'export const value = 0\n',
			'node_modules/wrapper/node_modules/fake-native/package.json': JSON.stringify({
				name: 'fake-native',
				version: '1.0.0',
				main: 'index.js',
				napi: { binaryName: 'fake' },
			}),
			'node_modules/wrapper/node_modules/fake-native/index.js': 'module.exports = { value: 42 }\n',
		})
		const entryPath = `${fixture.path}/task.ts`
		const outFile = `${fixture.path}/dist/task.mjs`
		await buildNodeModule({ root: fixture.path, entryPath, outFile })

		const output = await readFile(outFile, 'utf8')
		expect(output).not.toMatch(/from ["']fake-native["']/)
		expect(output).toContain('fake-native')
		const module = await import(`${pathToFileURL(outFile).href}?test=nested-native`)
		expect(module.default()).toBe(42)
		await expect(resolveNodeModuleNativeResiduals(entryPath, fixture.path)).resolves.toEqual([
			expect.objectContaining({ name: 'fake-native' }),
		])
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

	it('rejects native import shapes that cannot preserve ESM namespace semantics', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ dependencies: { 'fake-native': '1.0.0' } }),
			'namespace.ts': "import * as native from 'fake-native'\nexport default native\n",
			'dynamic.ts': "export default () => import('fake-native')\n",
			'star.ts': "export * from 'fake-native'\n",
			'node_modules/fake-native/package.json': JSON.stringify({
				name: 'fake-native',
				version: '1.0.0',
				main: 'index.js',
				napi: { binaryName: 'fake' },
			}),
			'node_modules/fake-native/index.js': 'module.exports = { value: 42 }\n',
		})
		for (const [entry, message] of [
			['namespace.ts', 'namespace imports'],
			['dynamic.ts', 'dynamic imports'],
			['star.ts', 'export *'],
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
})
