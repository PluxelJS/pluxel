import * as fs from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SuperJSON } from 'superjson'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { Passthrough } from '@pluxel/core/fs'
import { requireTinyBaseHost } from '@pluxel/core/internal'
import {
	__setPluginConfig,
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
} from '@pluxel/core/toolchain'
import { createHost } from '../../src/index.ts'

const options = JSON.parse(process.argv[2])
const updates = []
let armedPhase
let armedSequence
async function pauseAt(phase, document) {
	if (armedPhase !== phase) return
	if (armedSequence !== undefined && SuperJSON.parse(document).seq !== armedSequence) return
	armedPhase = undefined
	process.send({
		gate: { phase, document, version: host.config.status().version, updates: [...updates] },
	})
	await new Promise(() => {})
}
const schema = {
	'~standard': {
		version: 1,
		vendor: 'process-config-fixture',
		validate(input) {
			const value = input?.value ?? 'seed'
			return typeof value === 'string'
				? { value: { value } }
				: { issues: [{ message: 'Expected string value', path: ['value'] }] }
		},
	},
}
class Configured extends BasePlugin {
	config = this.configs.use(schema)
	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			updates.push(desired.value)
		})
	}
}
Plugin()(Configured)
__setPluginDefinition(Configured, {
	abiVersion: PLUGIN_LOWERING_ABI_VERSION,
	kind: 'plugin',
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/config-sync-process' },
		exportName: 'Configured',
	},
})
__setPluginConfig(Configured, {
	abiVersion: PLUGIN_LOWERING_ABI_VERSION,
	fieldName: 'config',
	schema,
})
const owner = pluginNodeAddressOf(Configured)
fs.mkdirSync(options.data, { recursive: true })
const common = {
	scope: 'process-deployment',
	artifact: { name: '@fixture/config-sync-process', catalogHash: 'b'.repeat(64) },
}
const credential = { identity: 'replica', token: 'process-deployment-secret' }
const host = await createHost({
	plugins: [Configured],
	config: {
		storage: {
			mounts: { '/': { backend: Passthrough, fs, prefix: options.data } },
			durableMounts: ['/'],
		},
	},
	configRecords: {
		storage(root) {
			const documents = requireTinyBaseHost(root).documents('config')
			return {
				getText: (key) => documents.getText(key),
				stat: (key) => documents.stat(key),
				async put(key, text) {
					await pauseAt('before-save', text)
					await documents.put(key, text)
					await pauseAt('after-save', text)
				},
			}
		},
	},
	state: { initial: { autoStart: [owner] } },
	configSync:
		options.role === 'writer'
			? { ...common, role: 'writer', identity: 'writer', replicas: [credential] }
			: { ...common, role: 'replica', ...credential, writer: 'writer', url: options.url },
})
await host.start()
let server
let url
if (options.role === 'writer') {
	server = createServer(async (request, response) => {
		const abort = new AbortController()
		response.once('close', () => abort.abort())
		try {
			if (request.method === 'POST' && request.url === '/manage') {
				let body = ''
				for await (const chunk of request) body += chunk
				const input = JSON.parse(body)
				const result = await host.config.patch(
					owner,
					{ value: input.value },
					{ expected: input.expected },
				)
				if (input.dropReply) response.destroy()
				else response.end(JSON.stringify(project(result)))
				return
			}
			const result = await host.configSync.fetch(
				new Request(`http://${request.headers.host}${request.url}`, {
					headers: request.headers,
					signal: abort.signal,
				}),
			)
			const text = await result.text()
			await pauseAt('before-broadcast', text)
			response.writeHead(result.status, Object.fromEntries(result.headers))
			response.end(text)
		} catch {
			if (!response.destroyed) {
				response.writeHead(503)
				response.end()
			}
		}
	})
	server.listen(options.port ?? 0, '127.0.0.1')
	await once(server, 'listening')
	url = `http://127.0.0.1:${server.address().port}/config`
}
function project(result) {
	return {
		ok: result.ok,
		code: result.code,
		config: result.config,
		version: result.version,
		application: result.application,
		readonly: result.readonly,
	}
}
process.on('message', async ({ id, op, value, expected, phase, seq }) => {
	try {
		if (op === 'arm') {
			armedPhase = phase
			armedSequence = seq
			process.send({ id, result: { armed: phase } })
		} else if (op === 'patch')
			process.send({ id, result: project(await host.config.patch(owner, { value }, { expected })) })
		else if (op === 'reset')
			process.send({ id, result: project(await host.config.reset(owner, undefined, { expected })) })
		else if (op === 'status')
			process.send({
				id,
				result: {
					config: project(await host.config.get(owner)),
					sync: host.configSync.status(),
					updates: [...updates],
				},
			})
		else if (op === 'close') {
			await host.close()
			if (server) {
				server.closeAllConnections()
				await new Promise((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				)
			}
			process.send({ id, result: { closed: true } }, () => process.exit(0))
		}
	} catch (error) {
		process.send({ id, error: error instanceof Error ? error.message : String(error) })
	}
})
process.send({ ready: true, pid: process.pid, url, version: host.config.status().version })
