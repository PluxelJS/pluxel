import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export async function checkCompletions({
	compiler,
	root,
	filename,
	extraProbes = '',
	extraMarkers = [],
}) {
	const server = spawn(process.execPath, [compiler, '--lsp', '--stdio'], {
		cwd: root,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	let buffer = Buffer.alloc(0),
		serial = 0
	const pending = new Map()
	function send(message) {
		const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
		server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
		server.stdin.write(body)
	}
	function request(method, params) {
		return new Promise((resolve, reject) => {
			const id = ++serial
			const timer = setTimeout(() => {
				pending.delete(id)
				reject(new Error(`Timeout: ${method}`))
			}, 15000)
			pending.set(id, (message) => {
				clearTimeout(timer)
				message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
			})
			send({ id, method, params })
		})
	}
	server.stdout.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk])
		for (;;) {
			const boundary = buffer.indexOf('\r\n\r\n')
			if (boundary < 0) return
			const length = Number(
				/Content-Length: (\d+)/i.exec(buffer.subarray(0, boundary).toString())[1],
			)
			if (buffer.length < boundary + 4 + length) return
			const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length))
			buffer = buffer.subarray(boundary + 4 + length)
			if (message.method && message.id !== undefined)
				send({
					id: message.id,
					result:
						message.method === 'workspace/configuration'
							? (message.params.items ?? []).map(() => ({}))
							: null,
				})
			else if (pending.has(message.id)) {
				pending.get(message.id)(message)
				pending.delete(message.id)
			}
		}
	})
	server.stderr.resume()
	try {
		await request('initialize', {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
		})
		send({ method: 'initialized', params: {} })
		const original = await readFile(filename, 'utf8')
		const probes = `
envBinding(ExamplePlugin, {config:{schema:ExampleConfig,mapping:{ /* config-completion */ }}})
envBinding(ExamplePlugin, {config:{schema:ExampleConfig,mapping:{payload:{ /* payload-completion */ }}}})
envBinding(ExamplePlugin, {vault:{schema:ExampleCredentials,mapping:{ /* vault-completion */ }}})
envBinding(ExamplePlugin, {vault:{schema:ExampleCredentials,mapping:{credentials:{ /* credential-completion */ }}}})
`
		const text = original + probes + extraProbes,
			uri = pathToFileURL(filename).href
		send({
			method: 'textDocument/didOpen',
			params: { textDocument: { uri, languageId: 'typescript', version: 1, text } },
		})
		const lines = text.split('\n'),
			report = {}
		for (const [marker, required] of [
			['config-completion', ['mode', 'payload', 'transport']],
			['payload-completion', ['raw']],
			['vault-completion', ['credentials']],
			['credential-completion', ['token']],
			...extraMarkers,
		]) {
			const line = lines.findIndex((line) => line.includes(marker))
			const completion = await request('textDocument/completion', {
				textDocument: { uri },
				position: { line, character: lines[line].indexOf('/*') },
				context: { triggerKind: 1 },
			})
			const labels = (Array.isArray(completion) ? completion : completion.items).map((item) =>
				item.label.replace(/\?$/, ''),
			)
			for (const item of required) assert.ok(labels.includes(item), JSON.stringify(labels))
			assert.ok(!labels.includes('inputType'))
			report[marker] = labels
		}
		send({
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri, version: 2 },
				contentChanges: [
					{
						text:
							text +
							`
envBinding(ExamplePlugin, {vault:{schema:ExampleCredentials,mapping:{wrongKey:'ENV'}}})
`,
					},
				],
			},
		})
		const diagnostics = await request('textDocument/diagnostic', { textDocument: { uri } })
		assert.ok(
			diagnostics.items.some((item) => item.code === 2353 && item.message.includes('wrongKey')),
			JSON.stringify(diagnostics),
		)
		report.diagnostics = diagnostics.items.map((item) => ({
			code: item.code,
			message: item.message,
		}))
		await request('shutdown', undefined)
		send({ method: 'exit' })
		return report
	} finally {
		server.kill()
	}
}
