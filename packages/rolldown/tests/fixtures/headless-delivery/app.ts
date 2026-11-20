import { join } from 'node:path'
import { defineHostApplication, type HostApplicationFactory } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { listenElysia } from '@pluxel/services/elysia/node'
import { prepareDatabase } from './database.js'
import { PdfHttpPlugin, QueryHttpPlugin } from './plugins.js'

export default defineHostApplication<HostApplicationFactory>((startup) => ({
	name: 'headless-documents',
	plugins: [
		{ plugin: QueryHttpPlugin, autoStart: true, config: { fail: startup.env.FAIL_QUERY === '1' } },
		{ plugin: PdfHttpPlugin, autoStart: true },
	],
	services: [elysia()],
	async prepare({ host }) {
		const directory = startup.env.DATA_DIRECTORY
		if (!directory) throw new Error('DATA_DIRECTORY is required')
		await prepareDatabase(host.ctx, directory)
	},
	async launch({ host }) {
		const listener = await listenElysia(host, {
			hostname: '127.0.0.1',
			port: 0,
			publicDir: join(startup.deployment?.root ?? startup.root, 'public'),
		})
		console.log(`LISTENING ${listener.address.port}`)
	},
}))
