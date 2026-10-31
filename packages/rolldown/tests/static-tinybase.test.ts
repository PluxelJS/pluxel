import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import { expect, it } from 'vitest'
import { staticTinybasePlugin } from '../src/cli/static-workbench-capnweb'

async function fixture(installed = '10.0.1', peer: string | undefined = '10.0.1') {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-static-tinybase-'))
	const put = async (path: string, value: unknown) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
	}
	const tinybase = async (path: string, version: string) => {
		await put(`${path}/package.json`, {
			name: 'tinybase',
			version,
			type: 'module',
			exports: {
				'.': './store.mjs',
				'./queries': './queries.mjs',
				'./ui-react': { browser: './browser.mjs', default: './react.mjs' },
			},
		})
		await put(`${path}/store.mjs`, 'export const createStore = () => ({})')
		await put(`${path}/queries.mjs`, 'export const createQueries = () => ({})')
		await put(`${path}/react.mjs`, "export const Provider = () => 'node'")
		await put(`${path}/browser.mjs`, "export const Provider = () => 'browser'")
	}
	await put('package.json', {
		name: 'application',
		type: 'module',
		dependencies: { tinybase: '10.0.1' },
	})
	await put('node_modules/@pluxel/services/package.json', {
		name: '@pluxel/services',
		peerDependencies: { tinybase: '10.0.1' },
		version: '1.0.0',
		type: 'module',
		exports: { './package.json': './package.json', './tinybase': './tinybase.mjs' },
	})
	await put(
		'node_modules/@pluxel/services/tinybase.mjs',
		"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'; export { Provider } from 'tinybase/ui-react'",
	)
	await tinybase('node_modules/@pluxel/services/node_modules/tinybase', '10.0.1')
	await tinybase('node_modules/tinybase', '10.0.1')
	for (const [name, version, shared] of [
		['consumer', installed, true],
		['library', '10.0.1', true],
		['private-store', '9.9.0', false],
	] as const) {
		await put(`node_modules/${name}/package.json`, {
			name,
			version: '1.0.0',
			type: 'module',
			exports: './index.mjs',
			...(shared
				? {
						peerDependencies: peer ? { tinybase: peer } : {},
						...(name === 'consumer' ? { pluxel: { tinybase: '10.0.1' } } : {}),
					}
				: { dependencies: { tinybase: version } }),
		})
		await put(
			`node_modules/${name}/index.mjs`,
			"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'; export { Provider } from 'tinybase/ui-react'",
		)
		await tinybase(`node_modules/${name}/node_modules/tinybase`, version)
	}
	await put(
		'app.mjs',
		`
import * as Host from '@pluxel/services/tinybase'
import * as Consumer from 'consumer'
import * as Library from 'library'
import * as Private from 'private-store'
export const shared = Consumer.createStore === Host.createStore && Library.createStore === Host.createStore
export const subpaths = Consumer.createQueries === Host.createQueries && Consumer.Provider === Host.Provider
export const privateIndependent = Private.createStore !== Host.createStore && Private.createQueries !== Host.createQueries
export const platform = Consumer.Provider()
`,
	)
	return { root, entry: join(root, 'app.mjs') }
}

it.each([
	['node', 'node'],
	['browser', 'browser'],
])(
	'binds same-version TinyBase installations and original subpaths under %s conditions while preserving private stores',
	async (condition, platform) => {
		const { root, entry } = await fixture()
		try {
			const bundle = await rolldown({
				input: entry,
				platform: condition === 'node' ? 'node' : 'browser',
				plugins: [staticTinybasePlugin(entry)],
				resolve: { conditionNames: [condition!, 'import', 'default'] },
			})
			try {
				const file = join(root, 'bundle.mjs')
				await bundle.write({ file, format: 'esm' })
				const result = await import(pathToFileURL(file).href)
				expect(result).toMatchObject({
					shared: true,
					subpaths: true,
					privateIndependent: true,
					platform,
				})
			} finally {
				await bundle.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

it.each([
	['10.1.0', '10.0.1', /resolved 10\.1\.0/],
	['10.0.1', '^10.0.1', /peerDependencies.tinybase \^10\.0\.1/],
])(
	'rejects shared TinyBase %s with peer %s before replacing the installation',
	async (version, peer, message) => {
		const { root, entry } = await fixture(version as string, peer as string)
		try {
			const bundle = await rolldown({ input: entry, plugins: [staticTinybasePlugin(entry)] })
			try {
				await expect(
					bundle.write({ file: join(root, 'bundle.mjs'), format: 'esm' }),
				).rejects.toThrow(message as RegExp)
			} finally {
				await bundle.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)
