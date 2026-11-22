import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import { expect, it } from 'vitest'
import { staticFrameworkSingletonPlugin } from '../src/cli/framework-singletons'

it('shares application-selected framework root, subpath and relative imports across physical peer copies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-framework-singletons-'))
	const put = async (path: string, content: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
	}
	try {
		for (const directory of [
			'node_modules/@example/service',
			'plugin/node_modules/@example/service',
		]) {
			await put(
				`${directory}/package.json`,
				JSON.stringify({
					name: '@example/service',
					type: 'module',
					exports: { '.': './index.js', './http': './http.js' },
				}),
			)
			await put(`${directory}/http.js`, 'export const token = Symbol("http")')
			await put(`${directory}/index.js`, 'export { token } from "./http.js"')
		}
		await put('plugin/index.js', 'export { token as pluginToken } from "@example/service/http"')
		await put(
			'app.js',
			'import { token } from "@example/service"; import { pluginToken } from "./plugin/index.js"; export const same = token === pluginToken',
		)
		const entry = join(root, 'app.js')
		const bundle = await rolldown({
			input: entry,
			plugins: [staticFrameworkSingletonPlugin(entry, ['@example/service/http'])],
		})
		try {
			await bundle.write({ file: join(root, 'out.mjs'), format: 'esm' })
		} finally {
			await bundle.close()
		}
		const application = await import(pathToFileURL(join(root, 'out.mjs')).href)
		expect(application.same).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('uses one published Services build while preserving ordinary Plugin HMR', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-published-services-plugins-'))
	const put = async (path: string, content: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
	}
	try {
		await put(
			'node_modules/@pluxel/services/package.json',
			JSON.stringify({
				name: '@pluxel/services',
				type: 'module',
				exports: {
					'./plugins': { '@pluxel/hmr': './source.js', default: './published.js' },
					'./other': { '@pluxel/source': './source.js', default: './published.js' },
				},
			}),
		)
		await put('node_modules/@pluxel/services/source.js', 'export const value = "services-source"')
		await put(
			'node_modules/@pluxel/services/published.js',
			'export const value = "services-published"',
		)
		await put(
			'node_modules/ordinary-plugin/package.json',
			JSON.stringify({
				name: 'ordinary-plugin',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './source.js', default: './published.js' },
				},
			}),
		)
		await put('node_modules/ordinary-plugin/source.js', 'export const value = "plugin-source"')
		await put(
			'node_modules/ordinary-plugin/published.js',
			'throw new Error("must compile Plugin source")',
		)
		await put('relative.js', 'export const value = "relative-source"')
		await put(
			'app.js',
			`
import { value as official } from '@pluxel/services/plugins'
import { value as other } from '@pluxel/services/other'
import { value as plugin } from 'ordinary-plugin'
import { value as local } from './relative.js'
export const values = [official, other, plugin, local]
`,
		)
		const entry = join(root, 'app.js')
		const bundle = await rolldown({
			input: entry,
			resolve: {
				conditionNames: ['@pluxel/hmr', '@pluxel/source', 'import', 'production', 'default'],
			},
			plugins: [staticFrameworkSingletonPlugin(entry, [])],
		})
		try {
			await bundle.write({ file: join(root, 'out.mjs'), format: 'esm' })
		} finally {
			await bundle.close()
		}
		const application = await import(pathToFileURL(join(root, 'out.mjs')).href)
		expect(application.values).toEqual([
			'services-published',
			'services-published',
			'plugin-source',
			'relative-source',
		])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('shares Services capability tokens between the published Plugin entry and the host entries', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-published-services-tokens-'))
	const put = async (path: string, content: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
	}
	try {
		await put(
			'node_modules/@pluxel/services/package.json',
			JSON.stringify({
				name: '@pluxel/services',
				type: 'module',
				exports: {
					'./plugins': { '@pluxel/hmr': './src/plugins.js', default: './dist/plugins.js' },
					'./preset': { '@pluxel/source': './src/preset.js', default: './dist/preset.js' },
				},
			}),
		)
		// Source and published builds each define the token; identity decides whether they match.
		await put(
			'node_modules/@pluxel/services/src/token.js',
			'export const Vault = Object.freeze({})',
		)
		await put(
			'node_modules/@pluxel/services/src/plugins.js',
			'export { Vault as required } from "./token.js"',
		)
		await put(
			'node_modules/@pluxel/services/src/preset.js',
			'export { Vault as installed } from "./token.js"',
		)
		await put(
			'node_modules/@pluxel/services/dist/token-chunk.js',
			'export const Vault = Object.freeze({})',
		)
		await put(
			'node_modules/@pluxel/services/dist/plugins.js',
			'export { Vault as required } from "./token-chunk.js"',
		)
		await put(
			'node_modules/@pluxel/services/dist/preset.js',
			'export { Vault as installed } from "./token-chunk.js"',
		)
		await put(
			'app.js',
			`
import { required } from '@pluxel/services/plugins'
import { installed } from '@pluxel/services/preset'
export const same = required === installed
`,
		)
		const entry = join(root, 'app.js')
		const bundle = await rolldown({
			input: entry,
			resolve: {
				conditionNames: ['@pluxel/hmr', '@pluxel/source', 'import', 'production', 'default'],
			},
			plugins: [staticFrameworkSingletonPlugin(entry, [])],
		})
		try {
			await bundle.write({ file: join(root, 'out.mjs'), format: 'esm' })
		} finally {
			await bundle.close()
		}
		const application = await import(pathToFileURL(join(root, 'out.mjs')).href)
		expect(application.same).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
