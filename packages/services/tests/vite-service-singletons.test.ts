import { host } from '@pluxel/host-vite'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { build, createServer, type RunnableDevEnvironment } from 'vite'
import { expect, it } from 'vitest'
import { serviceSingletons } from '../src/vite'

function capnweb(version: string) {
	return {
		'package.json': JSON.stringify({
			name: 'capnweb',
			version,
			type: 'module',
			exports: './index.js',
		}),
		'index.js': 'export class RpcTarget {}',
	}
}

async function runFixture(
	options: { publisherVersion?: string; publisherPeer?: string; marker?: string } = {},
) {
	const files: Record<string, string> = {
		'app.ts':
			'import { defineHostApplication } from "@pluxel/host"; export default defineHostApplication(() => ({ plugins: [] }))',
		'package.json': JSON.stringify({ type: 'module', dependencies: { capnweb: '0.12.0' } }),
		'node_modules/@pluxel/workbench/package.json': JSON.stringify({
			name: '@pluxel/workbench',
			version: '1.0.0',
			type: 'module',
			exports: './index.js',
			peerDependencies: { capnweb: '0.12.0' },
		}),
		'node_modules/@pluxel/workbench/index.js': 'export { RpcTarget } from "capnweb"',
		'platform-kit/package.json': JSON.stringify({
			name: 'platform-kit',
			peerDependencies: { capnweb: '0.12.0' },
			devDependencies: { capnweb: '0.12.0' },
		}),
		'platform-kit/target.ts':
			'import { RpcTarget } from "capnweb"; export class PlatformTarget extends RpcTarget {}',
		'publisher/package.json': JSON.stringify({
			name: 'publisher',
			peerDependencies:
				options.publisherPeer === undefined
					? { capnweb: '0.12.0' }
					: options.publisherPeer
						? { capnweb: options.publisherPeer }
						: {},
			devDependencies: { capnweb: '0.12.0' },
			...(options.marker ? { pluxel: { workbenchCapnweb: options.marker } } : {}),
		}),
		'publisher/target.ts':
			'import { PlatformTarget } from "../platform-kit/target"; import { RpcTarget } from "capnweb"; export class Target extends PlatformTarget {}; export const ownShared = RpcTarget === Object.getPrototypeOf(PlatformTarget)',
		'private-rpc/package.json': JSON.stringify({
			name: 'private-rpc',
			dependencies: { capnweb: '0.13.0' },
		}),
		'private-rpc/target.ts': 'export { RpcTarget } from "capnweb"',
		'entry.ts':
			'import { RpcTarget as Host } from "@pluxel/workbench"; import { Target, ownShared } from "./publisher/target"; import { RpcTarget as Private } from "./private-rpc/target"; export const matches = new Target() instanceof Host && ownShared; export const privateIndependent = Private !== Host',
	}
	for (const [path, content] of Object.entries(capnweb('0.12.0'))) {
		files[`node_modules/capnweb/${path}`] = content
		files[`node_modules/@pluxel/workbench/node_modules/capnweb/${path}`] = content
		files[`platform-kit/node_modules/capnweb/${path}`] = content
		files[`publisher/node_modules/capnweb/${path}`] =
			path === 'package.json' && options.publisherVersion
				? capnweb(options.publisherVersion)[path]!
				: content
	}
	for (const [path, content] of Object.entries(capnweb('0.13.0')))
		files[`private-rpc/node_modules/capnweb/${path}`] = content
	await using fixture = await createDiskFixture(files)
	const server = await createServer({
		configFile: false,
		root: fixture.getPath(),
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		plugins: [serviceSingletons(), ...host({ entry: fixture.getPath('app.ts') })],
	})
	try {
		const environment = server.environments.pluxel as RunnableDevEnvironment
		return (await environment.runner.import(fixture.getPath('entry.ts'))) as {
			matches: boolean
			privateIndependent: boolean
		}
	} finally {
		await server.close()
	}
}

it('shares source publisher and base-library RpcTarget with Workbench across equal-version installations while leaving private RPC alone', async () => {
	const result = await runFixture()
	expect(result.matches).toBe(true)
	expect(result.privateIndependent).toBe(true)
})

it('rejects a source publisher installation before replacing its incompatible constructor', async () => {
	await expect(runFixture({ publisherVersion: '0.13.0' })).rejects.toThrow(
		/publisher.*resolved 0\.13\.0.*Host Workbench supports 0\.12\.0/,
	)
})

it('rejects a marked publisher with no declared peer', async () => {
	await expect(runFixture({ publisherPeer: '', marker: '0.12.0' })).rejects.toThrow(
		/publisher.*peerDependencies\.capnweb <missing>/,
	)
})

async function runTinybaseFixture(
	options: { version?: string; peer?: string; hostDependency?: string; browser?: boolean } = {},
) {
	const files: Record<string, string> = {
		'app.ts':
			'import { defineHostApplication } from "@pluxel/host"; export default defineHostApplication(() => ({ plugins: [] }))',
		'package.json': JSON.stringify({
			name: 'application',
			type: 'module',
			dependencies: { tinybase: options.hostDependency ?? '10.0.1' },
		}),
		'node_modules/@pluxel/services/package.json': JSON.stringify({
			name: '@pluxel/services',
			version: '1.0.0',
			type: 'module',
			exports: {
				'.': './index.mjs',
				'./package.json': './package.json',
				'./tinybase': './tinybase.mjs',
			},
			peerDependencies: { tinybase: '10.0.1' },
			devDependencies: { tinybase: '10.0.1' },
		}),
		'node_modules/@pluxel/services/index.mjs': 'export {}',
		'node_modules/@pluxel/services/tinybase.mjs':
			"export const TinyBase = {}; export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'; export { Provider } from 'tinybase/ui-react'",
		'consumer/package.json': JSON.stringify({
			name: 'consumer',
			peerDependencies: options.peer === '' ? {} : { tinybase: options.peer ?? '10.0.1' },
			devDependencies: { tinybase: '10.0.1' },
		}),
		'consumer/store.ts':
			"import { TinyBase } from '@pluxel/services/tinybase'; export const service = TinyBase; export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'; export { Provider } from 'tinybase/ui-react'",
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
			"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'",
		'entry.ts': `
import * as Host from '@pluxel/services/tinybase'
import * as Consumer from './consumer/store'
import * as Library from './library/store'
import * as Private from './private-store/store'
import { createStore as ApplicationStore } from 'tinybase'
export const shared = Consumer.createStore === Host.createStore && Library.createStore === Host.createStore && ApplicationStore === Host.createStore
export const subpaths = Consumer.createQueries === Host.createQueries && Library.createQueries === Host.createQueries && Consumer.Provider === Host.Provider
export const privateIndependent = Private.createStore !== Host.createStore && Private.createQueries !== Host.createQueries
export const platform = Consumer.Provider()
`,
	}
	for (const [path, version] of [
		['node_modules/tinybase', '10.0.1'],
		['node_modules/@pluxel/services/node_modules/tinybase', '10.0.1'],
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
			plugins: [serviceSingletons('app.ts')],
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
		plugins: [serviceSingletons('app.ts'), ...host({ entry: fixture.getPath('app.ts') })],
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
	})
})

it('keeps shared browser Provider imports on one TinyBase module and preserves browser conditions', async () => {
	expect(await runTinybaseFixture({ browser: true })).toMatchObject({
		shared: true,
		subpaths: true,
		privateIndependent: true,
		platform: 'browser',
	})
})

it.each([
	[{ version: '10.1.0' }, /consumer.*resolved 10\.1\.0.*Host TinyBase supports 10\.0\.1/],
	[{ peer: '' }, /consumer.*peerDependencies.tinybase <missing>/],
	[{ peer: '^10.0.1' }, /consumer.*peerDependencies.tinybase \^10\.0\.1/],
	[{ hostDependency: '^10.0.1' }, /application.*dependencies.tinybase \^10\.0\.1/],
] as const)(
	'rejects incompatible TinyBase source boundaries before replacing their modules: %j',
	async (options, diagnostic) => {
		await expect(runTinybaseFixture(options)).rejects.toThrow(diagnostic)
	},
)
