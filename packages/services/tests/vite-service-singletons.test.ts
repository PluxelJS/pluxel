import { host } from '@pluxel/host-dev/vite'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { createServer, type RunnableDevEnvironment } from 'vite'
import { expect, it } from 'vitest'
import { serviceSingletons } from '../src/vite'

function capnweb(version: string) {
	return {
		'package.json': JSON.stringify({ name: 'capnweb', version, type: 'module', exports: './index.js' }),
		'index.js': 'export class RpcTarget {}',
	}
}

async function runFixture(options: { publisherVersion?: string; publisherPeer?: string; marker?: string } = {}) {
	const files: Record<string, string> = {
		'app.ts': 'import { defineHostApplication } from "@pluxel/host"; export default defineHostApplication(() => ({ plugins: [] }))',
		'package.json': JSON.stringify({ type: 'module', dependencies: { capnweb: '0.12.0' } }),
		'node_modules/@pluxel/workbench/package.json': JSON.stringify({ name: '@pluxel/workbench', type: 'module', exports: './index.js', peerDependencies: { capnweb: '0.12.0' } }),
		'node_modules/@pluxel/workbench/index.js': 'export { RpcTarget } from "capnweb"',
		'platform-kit/package.json': JSON.stringify({ name: 'platform-kit', peerDependencies: { capnweb: '0.12.0' }, devDependencies: { capnweb: '0.12.0' } }),
		'platform-kit/target.ts': 'import { RpcTarget } from "capnweb"; export class PlatformTarget extends RpcTarget {}',
		'publisher/package.json': JSON.stringify({
			name: 'publisher',
			peerDependencies: options.publisherPeer === undefined ? { capnweb: '0.12.0' } : options.publisherPeer ? { capnweb: options.publisherPeer } : {},
			devDependencies: { capnweb: '0.12.0' },
			...(options.marker ? { pluxel: { workbenchCapnweb: options.marker } } : {}),
		}),
		'publisher/target.ts': 'import { PlatformTarget } from "../platform-kit/target"; import { RpcTarget } from "capnweb"; export class Target extends PlatformTarget {}; export const ownShared = RpcTarget === Object.getPrototypeOf(PlatformTarget)',
		'private-rpc/package.json': JSON.stringify({ name: 'private-rpc', dependencies: { capnweb: '0.13.0' } }),
		'private-rpc/target.ts': 'export { RpcTarget } from "capnweb"',
		'entry.ts': 'import { RpcTarget as Host } from "@pluxel/workbench"; import { Target, ownShared } from "./publisher/target"; import { RpcTarget as Private } from "./private-rpc/target"; export const matches = new Target() instanceof Host && ownShared; export const privateIndependent = Private !== Host',
	}
	for (const [path, content] of Object.entries(capnweb('0.12.0'))) {
		files[`node_modules/capnweb/${path}`] = content
		files[`node_modules/@pluxel/workbench/node_modules/capnweb/${path}`] = content
		files[`platform-kit/node_modules/capnweb/${path}`] = content
		files[`publisher/node_modules/capnweb/${path}`] = path === 'package.json' && options.publisherVersion
			? capnweb(options.publisherVersion)[path]!
			: content
	}
	for (const [path, content] of Object.entries(capnweb('0.13.0'))) files[`private-rpc/node_modules/capnweb/${path}`] = content
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
		return await environment.runner.import(fixture.getPath('entry.ts')) as { matches: boolean; privateIndependent: boolean }
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
	await expect(runFixture({ publisherVersion: '0.13.0' })).rejects.toThrow(/publisher.*resolved 0\.13\.0.*Host Workbench supports 0\.12\.0/)
})

it('rejects a marked publisher with no declared peer', async () => {
	await expect(runFixture({ publisherPeer: '', marker: '0.12.0' })).rejects.toThrow(/publisher.*peerDependencies\.capnweb <missing>/)
})
