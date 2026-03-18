import { createServer } from 'node:http'
import { Readable } from 'node:stream'

function toFetchHeaders(headers) {
	const out = new Headers()
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) out.append(key, item)
			continue
		}
		out.set(key, String(value))
	}
	return out
}

function toFetchRequest(req, baseUrl) {
	const url = new URL(req.url ?? '/', baseUrl)
	const method = req.method ?? 'GET'
	const init = {
		method,
		headers: toFetchHeaders(req.headers),
		body: method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req),
	}
	if (init.body) init.duplex = 'half'
	return new Request(url, init)
}

async function writeFetchResponse(res, response) {
	res.statusCode = response.status
	for (const [key, value] of response.headers) {
		res.setHeader(key, value)
	}

	if (!response.body) {
		res.end()
		return
	}

	await new Promise((resolve, reject) => {
		Readable.fromWeb(response.body)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolve)
			.on('error', reject)
	})
}

export async function startFetchHostServer(options) {
	const host = options.host ?? '127.0.0.1'
	const port = Number(options.port ?? 3310)
	const server = createServer(async (req, res) => {
		try {
			const request = toFetchRequest(req, `http://${host}:${port}`)
			const response = await options.fetch(request)
			await writeFetchResponse(res, response)
		} catch (error) {
			res.statusCode = 500
			res.setHeader('Content-Type', 'text/plain; charset=utf-8')
			res.end(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	})

	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => {
			server.off('error', reject)
			resolve()
		})
	})

	return {
		host,
		port,
		baseUrl: `http://${host}:${port}`,
		close: async () =>
			new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	}
}
