import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import '@pluxel/runtime/services/web-management'
import { createStaticRuntime } from '@pluxel/runtime-static'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import staticRuntime from './pluxel.static.ts'

const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3312')
const repoRoot = resolve(import.meta.dirname, '../../../..')
const logsDir = resolve(repoRoot, 'packages/plugins/static-commercial-demo/logs')
const logFile = resolve(logsDir, 'runtime.log')

await mkdir(logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: logFile,
	ui: true,
	debug: ['pluxel:runtime:*'],
})

const runtime = await createStaticRuntime(staticRuntime)
const startup = await runtime.start()
runtime.ctx.logger.info('Static commercial runtime ready', {
	profile: process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-static-commercial-demo',
	startup: startup.entries.map(({ name, status }) => `${name}:${status}`),
})

const server = createServer(async (req, res) => {
	try {
		const request = toRequest(req)
		const response = await runtime.fetch(request)
		await writeResponse(res, response)
	} catch (error) {
		res.statusCode = 500
		res.setHeader('content-type', 'text/plain; charset=utf-8')
		res.end(error instanceof Error ? (error.stack ?? error.message) : String(error))
	}
})

await new Promise<void>((resolve, reject) => {
	server.once('error', reject)
	server.listen(bindPort, bindHost, () => {
		server.off('error', reject)
		resolve()
	})
})

console.info(`Static commercial host ready at http://${bindHost}:${bindPort}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void (async () => {
			await runtime.stop()
			server.close()
			process.exit(0)
		})()
	})
}

function toRequest(req: import('node:http').IncomingMessage): Request {
	const url = new URL(req.url ?? '/', `http://${bindHost}:${bindPort}`)
	const method = req.method ?? 'GET'
	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item)
			continue
		}
		headers.set(key, value)
	}

	const init: RequestInit & { duplex?: 'half' } = { method, headers }
	if (method !== 'GET' && method !== 'HEAD') {
		init.body = Readable.toWeb(req) as unknown as BodyInit
		init.duplex = 'half'
	}
	return new Request(url, init)
}

async function writeResponse(
	res: import('node:http').ServerResponse,
	response: Response,
): Promise<void> {
	res.statusCode = response.status
	response.headers.forEach((value, key) => res.setHeader(key, value))
	if (!response.body) {
		res.end()
		return
	}

	await new Promise<void>((resolve, reject) => {
		Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolve)
			.on('error', reject)
	})
}
