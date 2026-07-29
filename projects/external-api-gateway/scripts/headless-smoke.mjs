import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const dataRoot = await mkdtemp(join(tmpdir(), 'pluxel-external-gateway-'))
const previousWorkbench = process.env.PLUXEL_WORKBENCH
const previousDataRoot = process.env.PLUXEL_STATIC_DATA_ROOT

process.env.PLUXEL_WORKBENCH = 'false'
process.env.PLUXEL_STATIC_DATA_ROOT = dataRoot

let server

try {
	const port = await findAvailablePort()
	server = await createServer({
		root,
		configFile: resolve(root, 'vite.config.ts'),
		logLevel: 'error',
		server: { host: '127.0.0.1', port, strictPort: true },
	})
	await server.listen()
	const address = server.httpServer?.address()
	if (!address || typeof address === 'string')
		throw new Error('Headless smoke server has no TCP port')
	const origin = `http://127.0.0.1:${address.port}`

	const gateway = await getJson(`${origin}/external-gateway/status`)
	if (gateway.ok !== true || gateway.rpc !== '/external-gateway/rpc') {
		throw new Error(`Unexpected gateway status: ${JSON.stringify(gateway)}`)
	}

	const provider = await getJson(`${origin}/__pluxel/plugins/ZhipuProviderPlugin/zhipu/status`)
	if (provider.ok !== true || !provider.settings || !provider.status) {
		throw new Error(`Unexpected provider status: ${JSON.stringify(provider)}`)
	}
} finally {
	await server?.close()
	await rm(dataRoot, { recursive: true, force: true })
	restoreEnvironment('PLUXEL_WORKBENCH', previousWorkbench)
	restoreEnvironment('PLUXEL_STATIC_DATA_ROOT', previousDataRoot)
}

function findAvailablePort() {
	return new Promise((resolvePromise, reject) => {
		const probe = createTcpServer()
		probe.once('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address()
			if (!address || typeof address === 'string') {
				probe.close()
				reject(new Error('Port probe has no TCP address'))
				return
			}
			probe.close((error) => {
				if (error) reject(error)
				else resolvePromise(address.port)
			})
		})
	})
}

async function getJson(url) {
	const response = await fetch(url)
	if (!response.ok) throw new Error(`${url} returned ${response.status}`)
	const body = await response.text()
	try {
		return JSON.parse(body)
	} catch (error) {
		throw new Error(`${url} did not return JSON: ${body.slice(0, 120)}`, { cause: error })
	}
}

function restoreEnvironment(name, value) {
	if (value === undefined) delete process.env[name]
	else process.env[name] = value
}
