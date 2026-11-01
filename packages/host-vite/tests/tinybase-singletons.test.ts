import { fileURLToPath } from 'node:url'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { build, createServer, type RunnableDevEnvironment } from 'vite'
import { expect, it } from 'vitest'
import { host } from '../src/index'
import { hostSingletons } from '../src/singletons'

async function runTinybaseFixture(
	options: { version?: string; peer?: string; browser?: boolean } = {},
) {
	const files: Record<string, string> = {
		'app.ts':
			'import { defineHostApplication } from "@pluxel/host"; export default defineHostApplication(() => ({ plugins: [] }))',
		'package.json': JSON.stringify({
			name: 'application',
			type: 'module',
			dependencies: { tinybase: '10.0.1' },
		}),
		'consumer/package.json': JSON.stringify({
			name: 'consumer',
			pluxel: { tinybase: '10.0.1' },
			peerDependencies: options.peer === '' ? {} : { tinybase: options.peer ?? '10.0.1' },
			devDependencies: { tinybase: '10.0.1' },
		}),
		'consumer/store.ts':
			"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'; export { Provider } from 'tinybase/ui-react'",
		'library/package.json': JSON.stringify({
			name: 'library',
			peerDependencies: { tinybase: '10.0.1' },
			devDependencies: { tinybase: '10.0.1' },
		}),
		'library/store.ts':
			"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'",
		'private-store/package.json': JSON.stringify({
			name: 'private-store',
			dependencies: { tinybase: '9.9.0' },
		}),
		'private-store/store.ts':
			"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'; export { Provider } from 'tinybase/ui-react'",
		'entry.ts': `
import { createStore } from ${JSON.stringify(fileURLToPath(new URL('../../core/node_modules/tinybase/index.js', import.meta.url)))}
import { createQueries } from ${JSON.stringify(fileURLToPath(new URL('../../core/node_modules/tinybase/queries/index.js', import.meta.url)))}
import { Provider } from ${JSON.stringify(fileURLToPath(new URL('../../core/node_modules/tinybase/ui-react/index.js', import.meta.url)))}
const Host = { createStore, createQueries, Provider }
import * as Consumer from './consumer/store'
import * as Library from './library/store'
import * as Private from './private-store/store'
import { createStore as ApplicationStore } from 'tinybase'
export const shared = Consumer.createStore === Host.createStore && Library.createStore === Host.createStore
export const subpaths = Consumer.createQueries === Host.createQueries && Library.createQueries === Host.createQueries && Consumer.Provider === Host.Provider
export const applicationIndependent = ApplicationStore !== Host.createStore
export const privateIndependent = Private.createStore !== Host.createStore && Private.createQueries !== Host.createQueries
export const platform = Private.Provider()
`,
	}
	for (const [path, version] of [
		['node_modules/tinybase', '10.0.1'],
		['consumer/node_modules/tinybase', options.version ?? '10.0.1'],
		['library/node_modules/tinybase', '10.0.1'],
		['private-store/node_modules/tinybase', '9.9.0'],
	]) {
		files[`${path}/package.json`] = JSON.stringify({
			name: 'tinybase',
			version,
			type: 'module',
			exports: {
				'.': './store.mjs',
				'./queries': './queries.mjs',
				'./ui-react': { browser: './browser.mjs', default: './react.mjs' },
			},
		})
		files[`${path}/store.mjs`] = 'export const createStore = () => ({})'
		files[`${path}/queries.mjs`] = 'export const createQueries = () => ({})'
		files[`${path}/browser.mjs`] = "export const Provider = () => 'browser'"
		files[`${path}/react.mjs`] = "export const Provider = () => 'node'"
	}
	await using fixture = await createDiskFixture(files)
	if (options.browser) {
		const result = await build({
			configFile: false,
			root: fixture.getPath(),
			logLevel: 'silent',
			plugins: [hostSingletons()],
			build: {
				write: false,
				minify: false,
				lib: { entry: fixture.getPath('entry.ts'), formats: ['es'] },
			},
		})
		const output = Array.isArray(result) ? result[0] : result
		if (!output || !('output' in output)) throw new Error('Missing browser output')
		const entry = output.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry)
		if (!entry || entry.type !== 'chunk') throw new Error('Missing browser entry')
		return await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`)
	}
	const server = await createServer({
		configFile: false,
		root: fixture.getPath(),
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		plugins: [hostSingletons(), ...host({ entry: fixture.getPath('app.ts') })],
	})
	try {
		const environment = server.environments.pluxel as RunnableDevEnvironment
		return await environment.runner.import(fixture.getPath('entry.ts'))
	} finally {
		await server.close()
	}
}

it('binds native TinyBase source consumers, explicit peer libraries and upstream subpaths across installations, preserving private stores', async () => {
	expect(await runTinybaseFixture()).toMatchObject({
		shared: true,
		subpaths: true,
		privateIndependent: true,
		applicationIndependent: true,
	})
})

it('keeps shared browser Provider imports on one TinyBase module and preserves browser conditions', async () => {
	expect(await runTinybaseFixture({ browser: true })).toMatchObject({
		shared: true,
		subpaths: true,
		privateIndependent: true,
		applicationIndependent: true,
		platform: 'browser',
	})
})

it.each([
	[{ version: '10.1.0' }, /consumer.*resolved 10\.1\.0.*Host Core supports 10\.0\.1/],
	[{ peer: '' }, /consumer.*peerDependencies.tinybase <missing>/],
	[{ peer: '^10.0.1' }, /consumer.*peerDependencies.tinybase \^10\.0\.1/],
] as const)(
	'rejects incompatible TinyBase source boundaries before replacing their modules: %j',
	async (options, diagnostic) => {
		await expect(runTinybaseFixture(options)).rejects.toThrow(diagnostic)
	},
)
