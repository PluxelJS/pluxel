const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const http = require('node:http')
const vm = require('node:vm')

const socketPath = '/rpc/gateway.sock'
const authorization = `Bearer ${process.env.RPC_TOKEN}`
const headers = {
	authorization,
	'x-run-id': process.env.RPC_RUN_ID,
	'x-session-id': process.env.RPC_SESSION_ID,
}
const issuedCalls = []
let transportFailed = false

globalThis.fetch = async (_request, options) => {
	const body = String(options.body ?? '')
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				socketPath,
				path: '/',
				method: 'POST',
				headers: { ...headers, 'content-length': Buffer.byteLength(body) },
			},
			(response) => {
				const chunks = []
				response.on('data', (chunk) => chunks.push(chunk))
				response.on('error', reject)
				response.on('end', () => {
					resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }))
				})
			},
		)
		request.on('error', reject)
		request.end(body)
	})
}

function sendControl(message) {
	const body = JSON.stringify({ ...message, calls: issuedCalls })
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				socketPath,
				path: '/result',
				method: 'POST',
				headers: { ...headers, 'content-length': Buffer.byteLength(body) },
			},
			(response) => {
				response.resume()
				response.on('end', () =>
					response.statusCode === 204 ? resolve() : reject(Error('RUN_TRANSPORT')),
				)
			},
		)
		request.on('error', reject)
		request.end(body)
	})
}

function encode(value, transport = false) {
	if (value === undefined) return null
	const seen = new Set()
	let nodes = 0
	function copy(item, depth) {
		if (++nodes > 10_000 || depth > 32) throw Error('OUTPUT_LIMIT')
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
		if (typeof item === 'number' && Number.isFinite(item)) return item
		if (Array.isArray(item)) {
			if (seen.has(item)) throw Error('OUTPUT_ENCODING')
			if (item.length > 10_000) throw Error('OUTPUT_LIMIT')
			const prototype = Object.getPrototypeOf(item)
			const base = prototype && Object.getPrototypeOf(prototype)
			if (base === null || base === undefined || Object.getPrototypeOf(base) !== null) {
				throw Error('OUTPUT_ENCODING')
			}
			const descriptors = Object.getOwnPropertyDescriptors(item)
			if (
				Reflect.ownKeys(descriptors).some(
					(key) =>
						typeof key !== 'string' ||
						(key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)),
				)
			) {
				throw Error('OUTPUT_ENCODING')
			}
			seen.add(item)
			const array = []
			for (let index = 0; index < item.length; index++) {
				const descriptor = descriptors[index]
				if (!descriptor || !('value' in descriptor)) throw Error('OUTPUT_ENCODING')
				array.push(copy(descriptor.value, depth + 1))
			}
			seen.delete(item)
			return array
		}
		if (!item || typeof item !== 'object' || seen.has(item)) throw Error('OUTPUT_ENCODING')
		const prototype = Object.getPrototypeOf(item)
		if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
			throw Error('OUTPUT_ENCODING')
		seen.add(item)
		const object = {}
		for (const key of Reflect.ownKeys(item)) {
			const descriptor = Object.getOwnPropertyDescriptor(item, key)
			if (transport && typeof key === 'symbol' && !descriptor.enumerable) continue
			if (
				typeof key !== 'string' ||
				key === '__proto__' ||
				!descriptor.enumerable ||
				!('value' in descriptor)
			)
				throw Error('OUTPUT_ENCODING')
			Object.defineProperty(object, key, {
				value: copy(descriptor.value, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		seen.delete(item)
		return object
	}
	const result = copy(value, 0)
	if (Buffer.byteLength(JSON.stringify(result)) > 65_536) throw Error('OUTPUT_LIMIT')
	return result
}

async function main() {
	const { newHttpBatchRpcSession } = await import('/program/capnweb.mjs')
	const descriptions = JSON.parse(readFileSync('/program/methods.json', 'utf8'))
	const allowedMethods = new Map(descriptions.map(({ id, methods }) => [id, new Set(methods)]))
	let stub
	let activeStubCalls = 0
	const pending = new Set()
	const maxCalls = Number(process.env.RPC_MAX_CALLS)
	const maxConcurrent = Number(process.env.RPC_MAX_CONCURRENT)
	let callsMade = 0
	let limitExceeded = false
	let open = true
	const rpc = Object.freeze({
		open(id) {
			if (!open || !allowedMethods.has(id)) throw Error('FORBIDDEN')
			const api = Object.create(null)
			for (const method of allowedMethods.get(id)) {
				api[method] = (input) => {
					if (!open) return Promise.reject(Error('RUN_CLOSED'))
					const callId = randomUUID()
					issuedCalls.push(callId)
					if (callsMade >= maxCalls || pending.size >= maxConcurrent) {
						limitExceeded = true
						open = false
						return Promise.reject(Error('RUN_LIMIT'))
					}
					callsMade++
					let task
					let transportStarted = false
					try {
						const wireInput = encode(input)
						transportStarted = true
						if (!stub)
							stub = newHttpBatchRpcSession(new Request('http://localhost/rpc', { headers }))
						activeStubCalls++
						const settle = () => {
							activeStubCalls--
							if (activeStubCalls === 0) {
								stub[Symbol.dispose]()
								stub = undefined
							}
						}
						try {
							task = Promise.resolve(stub.invoke({ id, method, input: wireInput, callId })).then(
								(value) => {
									try {
										settle()
										return encode(value, true)
									} catch (cause) {
										transportFailed = true
										open = false
										throw cause
									}
								},
								(cause) => {
									transportFailed = true
									open = false
									settle()
									throw cause
								},
							)
						} catch (cause) {
							transportFailed = true
							open = false
							settle()
							task = Promise.reject(cause)
						}
					} catch (cause) {
						if (transportStarted) {
							transportFailed = true
							open = false
						}
						task = Promise.reject(cause)
					}
					pending.add(task)
					void task.then(
						() => pending.delete(task),
						() => pending.delete(task),
					)
					return task
				}
			}
			return Object.freeze(api)
		},
	})
	try {
		const source = readFileSync('/program/program.js', 'utf8')
		const exports = {}
		const context = vm.createContext({ exports })
		vm.runInContext(source, context, { timeout: 500 })
		const run = exports.default
		if (typeof run !== 'function') throw Error('RUN_SCRIPT')
		const value = await run(rpc)
		open = false
		if (limitExceeded) {
			await sendControl({ kind: 'limit_error' })
			process.exitCode = 23
			return
		}
		if (transportFailed) {
			await sendControl({ kind: 'transport_error' })
			process.exitCode = 24
			return
		}
		if (pending.size > 0) {
			await sendControl({ kind: 'pending_error' })
			process.exitCode = 21
			return
		}
		let output
		try {
			output = encode(value)
		} catch (cause) {
			await sendControl({
				kind: 'output_error',
				code: cause.message === 'OUTPUT_LIMIT' ? 'OUTPUT_LIMIT' : 'OUTPUT_ENCODING',
			})
			process.exitCode = 22
			return
		}
		await sendControl({ kind: 'result', value: output })
	} finally {
		open = false
		stub?.[Symbol.dispose]()
	}
}

main().catch(async () => {
	try {
		await sendControl({ kind: transportFailed ? 'transport_error' : 'script_error' })
	} catch {}
	process.exitCode = transportFailed ? 24 : 1
})
