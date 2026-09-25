const http = require('node:http')
const { randomUUID } = require('node:crypto')

const code = Buffer.from(process.env.RPC_PROGRAM, 'base64').toString('utf8')
const socketPath = '/rpc/gateway.sock'
const token = process.env.RPC_TOKEN

function invoke(input) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ callId: randomUUID(), input })
		const request = http.request(
			{
				socketPath,
				path: '/invoke',
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-run-token': token,
					'content-length': Buffer.byteLength(body),
				},
			},
			(response) => {
				const chunks = []
				response.on('data', (chunk) => chunks.push(chunk))
				response.on('end', () => {
					try {
						const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
						if (response.statusCode !== 200) reject(new Error(result.message ?? 'RPC failed'))
						else resolve(result)
					} catch (error) {
						reject(error)
					}
				})
			},
		)
		request.on('error', reject)
		request.end(body)
	})
}

async function main() {
	const run = new Function('require', 'process', 'rpc', `${code}\nreturn run`)(require, process, {
		invoke,
	})
	const value = await run({ invoke })
	process.stdout.write(`RPC_RESULT:${JSON.stringify(value)}\n`)
}

main().catch((error) => {
	process.stderr.write(`RPC_ERROR:${error instanceof Error ? error.message : 'unknown'}\n`)
	process.exitCode = 1
})
