import { join } from 'node:path'
import { defineHostApplication } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { listenElysia } from '@pluxel/services/elysia/node'
import { prepareDatabase } from './database.js'
import { PdfHttpPlugin, QueryHttpPlugin } from './plugins.js'

export default defineHostApplication((startup) => ({
	name: 'headless-documents',
	plugins: [QueryHttpPlugin, PdfHttpPlugin],
	services: [elysia()],
	policy: { autoStart: [QueryHttpPlugin, PdfHttpPlugin] },
	config: {
		records: [{ owner: QueryHttpPlugin, config: { fail: startup.env.FAIL_QUERY === '1' } }],
	},
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
