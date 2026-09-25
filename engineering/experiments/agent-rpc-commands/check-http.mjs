import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
	RpcTarget,
	newHttpBatchRpcSession,
	nodeHttpBatchRpcResponse,
} from '../../../packages/services/node_modules/capnweb/dist/index.js'

const MAX_BATCH = 3
const sessions = new Map(
	['sequential', 'parallel', 'bounded', 'one', 'two', 'drop-before', 'drop-after'].map((id) => [
		id,
		`secret-${id}`,
	]),
)
const requests = new Map()
const invocations = new Map()
const batches = []
const native = { opened: 0, disposed: 0, active: new Set() }

class Api extends RpcTarget {
	constructor(session, batch, socket) {
		super()
		this.session = session
		this.batch = batch
		this.socket = socket
	}
	async echo(value) {
		this.batch.calls.push(value)
		invocations.set(this.session, (invocations.get(this.session) ?? 0) + 1)
		if (this.session === 'drop-after') queueMicrotask(() => this.socket.destroy())
		return { session: this.session, value }
	}
}

const server = createServer((request, response) => {
	const session = new URL(request.url, 'http://localhost').searchParams.get('session')
	if (
		!sessions.has(session) ||
		request.headers.authorization !== `Bearer ${sessions.get(session)}`
	) {
		response.writeHead(403).end()
		return
	}
	requests.set(session, (requests.get(session) ?? 0) + 1)
	const batch = { session, calls: [] }
	batches.push(batch)
	if (session === 'drop-before') {
		request.socket.destroy()
		return
	}
	void nodeHttpBatchRpcResponse(request, response, new Api(session, batch, request.socket)).catch(
		(error) => {
			if (!response.destroyed) response.destroy(error)
		},
	)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/?session=`

// A stable run-local API creates and disposes one native stub for each bounded HTTP batch.
function createRun(session) {
	const request = new Request(base + session, {
		headers: { authorization: `Bearer ${sessions.get(session)}` },
	})
	let open = true
	let scheduled = false
	const queue = []
	const pending = new Set()
	const stubs = new Set()

	async function sendBatch(jobs) {
		const stub = newHttpBatchRpcSession(request)
		native.opened++
		native.active.add(stub)
		stubs.add(stub)
		try {
			const results = await Promise.allSettled(jobs.map((job) => stub.echo(job.value)))
			for (const [index, result] of results.entries()) {
				if (result.status === 'fulfilled') jobs[index].resolve(result.value)
				else jobs[index].reject(result.reason)
			}
		} finally {
			stub[Symbol.dispose]()
			await assert.rejects(async () => stub.echo('after-dispose'), /disposed/)
			native.disposed++
			native.active.delete(stub)
			stubs.delete(stub)
		}
	}
	function flush() {
		scheduled = false
		while (queue.length > 0) {
			const task = sendBatch(queue.splice(0, MAX_BATCH))
			pending.add(task)
			void task.finally(() => pending.delete(task))
		}
	}
	const api = Object.freeze({
		echo(value) {
			if (!open) return Promise.reject(new Error('Run is closed'))
			return new Promise((resolve, reject) => {
				queue.push({ value, resolve, reject })
				if (!scheduled) {
					scheduled = true
					queueMicrotask(flush)
				}
			})
		},
	})
	return {
		api,
		async close() {
			open = false
			if (scheduled) flush()
			await Promise.allSettled(pending)
			assert.equal(stubs.size, 0, 'run must release all native stubs')
		},
	}
}
async function withRun(session, work) {
	const run = createRun(session)
	try {
		return await work(run.api)
	} finally {
		await run.close()
	}
}

try {
	let retiredApi
	await withRun('sequential', async (api) => {
		retiredApi = api
		const first = await api.echo('first')
		assert.deepEqual(first, { session: 'sequential', value: 'first' })
		assert.deepEqual(await api.echo(`${first.value}-then-second`), {
			session: 'sequential',
			value: 'first-then-second',
		})
	})
	assert.equal(requests.get('sequential'), 2)
	await assert.rejects(retiredApi.echo('after-run'), /Run is closed/)
	retiredApi = undefined

	await withRun('parallel', async (api) => {
		const [a, b] = await Promise.all([api.echo('a'), api.echo('b')])
		assert.deepEqual([a.value, b.value], ['a', 'b'])
	})
	assert.equal(requests.get('parallel'), 1)
	assert.deepEqual(batches.find((batch) => batch.session === 'parallel').calls, ['a', 'b'])

	await withRun('bounded', async (api) => {
		const values = await Promise.all(Array.from({ length: 8 }, (_, index) => api.echo(index)))
		assert.deepEqual(
			values.map((value) => value.value),
			[0, 1, 2, 3, 4, 5, 6, 7],
		)
	})
	assert.equal(requests.get('bounded'), 3)
	assert.deepEqual(
		batches.filter((batch) => batch.session === 'bounded').map((batch) => batch.calls.length),
		[3, 3, 2],
	)
	assert(batches.every((batch) => batch.calls.length <= MAX_BATCH))

	await Promise.all([
		withRun('one', async (api) => {
			const values = await Promise.all([api.echo('one-a'), api.echo('one-b')])
			assert(values.every((item) => item.session === 'one'))
		}),
		withRun('two', async (api) => {
			const values = await Promise.all([api.echo('two-a'), api.echo('two-b')])
			assert(values.every((item) => item.session === 'two'))
		}),
	])
	assert.equal(requests.get('one'), 1)
	assert.equal(requests.get('two'), 1)
	assert.deepEqual(batches.find((batch) => batch.session === 'one').calls, ['one-a', 'one-b'])
	assert.deepEqual(batches.find((batch) => batch.session === 'two').calls, ['two-a', 'two-b'])

	await assert.rejects(withRun('drop-before', (api) => api.echo('lost')))
	assert.equal(requests.get('drop-before'), 1)
	assert.equal(invocations.get('drop-before') ?? 0, 0)
	await assert.rejects(withRun('drop-after', (api) => api.echo('committed-but-lost')))
	assert.equal(requests.get('drop-after'), 1, 'uncertain call must not replay')
	assert.equal(invocations.get('drop-after'), 1, 'handler may run even when delivery fails')

	assert.equal(native.active.size, 0)
	assert.equal(native.opened, native.disposed)
	console.log(
		JSON.stringify(
			{
				maxBatch: MAX_BATCH,
				requests: Object.fromEntries(requests),
				invocations: Object.fromEntries(invocations),
				native: { opened: native.opened, disposed: native.disposed, active: native.active.size },
				batches,
			},
			null,
			2,
		),
	)
} finally {
	await new Promise((resolve) => server.close(resolve))
}
