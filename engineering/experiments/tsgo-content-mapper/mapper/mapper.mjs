// Fixture-only recognizer. This is NOT a parser for arbitrary Plugin TypeScript.
// Protocol: microsoft/TypeScript tsc/internal/contentmapper/hostimpl.go.
let pending = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
	pending = Buffer.concat([pending, chunk])
	for (;;) {
		const headerEnd = pending.indexOf('\r\n\r\n')
		if (headerEnd < 0) return
		const length = Number(
			/Content-Length: (\d+)/i.exec(pending.subarray(0, headerEnd).toString())[1],
		)
		if (pending.length < headerEnd + 4 + length) return
		const request = JSON.parse(pending.subarray(headerEnd + 4, headerEnd + 4 + length))
		pending = pending.subarray(headerEnd + 4 + length)
		if (request.id === undefined) continue
		let result = null
		if (request.method === 'initialize')
			result = { positionEncoding: 'utf-16', diagnosticSource: 'pluxel-experiment' }
		if (request.method === 'openProject') result = {}
		if (request.method === 'transform') {
			const { content } = request.params
			const name = /export class (\w+)/.exec(content)?.[1]
			const schema = /this\.configs\.use\((\w+)\)/.exec(content)?.[1]
			const generated =
				name && schema
					? `\nexport interface ${name} { readonly __pluxelInputs: typeof ${schema}["input"] }\n`
					: ''
			result = {
				text: content + generated,
				extension: '.ts',
				mappings: [[0, content.length, 0, content.length, 0]],
			}
		}
		const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
		process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
		process.stdout.write(body)
	}
})
