import { host } from '@pluxel/host-dev/vite'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { createServer, type RunnableDevEnvironment } from 'vite'
import { expect, it } from 'vitest'
import { serviceSingletons } from '../src/vite'

it('shares Workbench RpcTarget with source publishers from a separate installation', async () => {
	await using fixture = await createDiskFixture({
		'app.ts':
			'import { defineHostApplication } from "@pluxel/host"; export default defineHostApplication(() => ({ plugins: [] }))',
		'package.json': '{"type":"module"}',
		'node_modules/@pluxel/workbench/package.json':
			'{"name":"@pluxel/workbench","type":"module","exports":"./index.js"}',
		'node_modules/@pluxel/workbench/index.js': 'export { RpcTarget } from "capnweb"',
		'node_modules/@pluxel/workbench/node_modules/capnweb/package.json':
			'{"name":"capnweb","version":"0.12.0","type":"module","exports":"./index.js"}',
		'node_modules/@pluxel/workbench/node_modules/capnweb/index.js': 'export class RpcTarget {}',
		'publisher/node_modules/capnweb/package.json':
			'{"name":"capnweb","version":"0.12.0","type":"module","exports":"./index.js"}',
		'publisher/node_modules/capnweb/index.js': 'export class RpcTarget {}',
		'publisher/target.ts':
			'import { RpcTarget } from "capnweb"; export class Target extends RpcTarget {}',
		'entry.ts':
			'import { RpcTarget } from "@pluxel/workbench"; import { Target } from "./publisher/target"; export const matches = new Target() instanceof RpcTarget',
	})
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
		const result = await environment.runner.import(fixture.getPath('entry.ts'))
		expect(result.matches).toBe(true)
	} finally {
		await server.close()
	}
})
