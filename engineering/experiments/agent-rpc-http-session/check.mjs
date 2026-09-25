import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
	RpcTarget,
	newHttpBatchRpcSession,
	nodeHttpBatchRpcResponse,
} from '../../../packages/services/node_modules/capnweb/dist/index.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_CALLS = 4
const MAX_QUEUED = 2
const MAX_INPUT_BYTES = 96
const records = { requests: [], calls: [], rejections: [], disposedStubs: 0, openedStubs: 0 }
let generation = 1
let publicationOpen = true
let ownerOpen = true
let ownerActive = 0
const ownerWaiters = []
const policy = new Map([
	['alice', new Set(['read', 'slow'])],
	['bob', new Set(['read'])],
])
const sessions = new Map()

function createSession(id, principal, methods) {
	const session = {
		id,
		token: `secret-${id}`,
		principal,
		generation,
		methods: new Set(methods),
		open: true,
	}
	sessions.set(session.token, session)
	return session
}

function acquireOwner() {
	if (!ownerOpen) throw Error('OWNER_GONE')
	ownerActive++
	let released = false
	return () => {
		if (released) return
		released = true
		ownerActive--
		if (ownerActive === 0) for (const resolve of ownerWaiters.splice(0)) resolve()
	}
}

async function stopOwner() {
	ownerOpen = false
	if (ownerActive) await new Promise((resolve) => ownerWaiters.push(resolve))
}

async function invoke(session, method, value, hold) {
	// The lease begins before asynchronous authorization and ends after the handler exits.
	if (!ownerOpen) return { error: 'FORBIDDEN_OR_GONE' }
	const release = acquireOwner()
	try {
		await wait(4)
		if (value === 'auth-race') {
			authEntered()
			await authPromise
		}
		if (
			!session.open ||
			!session.methods.has(method) ||
			!publicationOpen ||
			session.generation !== generation ||
			!ownerOpen ||
			!policy.get(session.principal)?.has(method)
		) {
			records.rejections.push({ session: session.id, method })
			return { error: 'FORBIDDEN_OR_GONE' }
		}
		records.calls.push({
			session: session.id,
			principal: session.principal,
			generation,
			method,
			value,
		})
		if (value === 'held') {
			slowStarted = true
			slowStartedResolve()
		}
		if (value === 'pending') pendingEntered()
		if (hold) await hold
		return { session: session.id, generation, value }
	} finally {
		release()
	}
}

let slowRelease
let slowStarted
let slowStartedResolve
const slowStartedPromise = new Promise((resolve) => (slowStartedResolve = resolve))
const slowPromise = new Promise((resolve) => (slowRelease = resolve))
let pendingRelease
const pendingPromise = new Promise((resolve) => (pendingRelease = resolve))
let pendingEntered
const pendingEnteredPromise = new Promise((resolve) => (pendingEntered = resolve))
let authEntered
let authRelease
const authEnteredPromise = new Promise((resolve) => (authEntered = resolve))
const authPromise = new Promise((resolve) => (authRelease = resolve))

class Api extends RpcTarget {
	constructor(session) {
		super()
		this.session = session
	}
	read(value) {
		return invoke(this.session, 'read', value)
	}
	async slow(value) {
		const pending = invoke(
			this.session,
			'slow',
			value,
			value === 'held' ? slowPromise : value === 'pending' ? pendingPromise : undefined,
		)
		return pending
	}
}

const server = createServer((request, response) => {
	const token = request.headers.authorization?.replace(/^Bearer /, '')
	const session = sessions.get(token)
	if (!session?.open) {
		response.writeHead(401).end()
		return
	}
	if (request.headers['x-session-id'] !== session.id) {
		response.writeHead(403).end()
		return
	}
	records.requests.push({ session: session.id, generation: session.generation })
	if (request.headers['x-drop'] === 'before') {
		request.socket.destroy()
		return
	}
	void nodeHttpBatchRpcResponse(request, response, new Api(session)).catch((error) => {
		if (!response.destroyed) response.destroy(error)
	})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

function createRun(session, options = {}) {
	let open = true
	let count = 0
	let inFlight = false
	const queue = []
	const pending = new Set()
	const abort = new AbortController()
	function pump() {
		if (inFlight || queue.length === 0) return
		inFlight = true
		const job = queue.shift()
		const request = new Request(url, {
			headers: {
				authorization: `Bearer ${session.token}`,
				'x-session-id': session.id,
				...(options.drop ? { 'x-drop': options.drop } : {}),
			},
			signal: abort.signal,
		})
		const stub = newHttpBatchRpcSession(request)
		records.openedStubs++
		const task = (async () => {
			let result
			let failure
			try {
				result = await stub[job.method](job.value)
			} catch (error) {
				failure = error
			} finally {
				stub[Symbol.dispose]()
				records.disposedStubs++
				inFlight = false
				pump()
			}
			pending.delete(task)
			if (failure) job.reject(failure)
			else job.resolve(result)
		})()
		pending.add(task)
	}
	const api = Object.freeze({
		call(method, value) {
			if (!open) return Promise.reject(Error('RUN_CLOSED'))
			if (++count > MAX_CALLS) return Promise.reject(Error('CALL_BUDGET'))
			if (Buffer.byteLength(JSON.stringify(value)) > MAX_INPUT_BYTES)
				return Promise.reject(Error('INPUT_BUDGET'))
			if (queue.length >= MAX_QUEUED) return Promise.reject(Error('QUEUE_FULL'))
			return new Promise((resolve, reject) => {
				queue.push({ method, value, resolve, reject })
				pump()
			})
		},
	})
	return {
		api,
		async finish(script) {
			let result
			let scriptError
			try {
				result = await script(api)
			} catch (error) {
				scriptError = error
			} finally {
				open = false
			}
			const unfinished = queue.length + pending.size
			if (unfinished) {
				abort.abort()
				for (const job of queue.splice(0)) job.reject(Error('RUN_PENDING_CALLS'))
				await Promise.allSettled([...pending])
				throw Error('RUN_PENDING_CALLS')
			}
			if (scriptError) throw scriptError
			return result
		},
		async close() {
			open = false
			abort.abort()
			for (const job of queue.splice(0)) job.reject(Error('RUN_CLOSED'))
			await Promise.allSettled([...pending])
		},
	}
}

try {
	const alice = createSession('alice-1', 'alice', ['read', 'slow'])
	const bob = createSession('bob-1', 'bob', ['read'])
	const aliceRun = createRun(alice)
	assert.deepEqual(await aliceRun.finish((api) => api.call('read', 'one')), {
		session: 'alice-1',
		generation: 1,
		value: 'one',
	})
	const bobRun = createRun(bob)
	assert.equal((await bobRun.finish((api) => api.call('read', 'two'))).session, 'bob-1')
	assert.deepEqual(
		records.requests.slice(0, 2).map((item) => item.session),
		['alice-1', 'bob-1'],
	)
	const stolen = newHttpBatchRpcSession(
		new Request(url, {
			headers: { authorization: `Bearer ${alice.token}`, 'x-session-id': bob.id },
		}),
	)
	await assert.rejects(async () => stolen.read('stolen'))
	stolen[Symbol.dispose]()
	assert.equal(
		records.calls.some((item) => item.value === 'stolen'),
		false,
	)

	const revoked = createRun(alice)
	alice.methods.delete('read')
	assert.deepEqual(await revoked.finish((api) => api.call('read', 'revoked')), {
		error: 'FORBIDDEN_OR_GONE',
	})
	assert.equal(
		records.calls.some((item) => item.value === 'revoked'),
		false,
	)
	const deniedBob = createRun(bob)
	assert.deepEqual(await deniedBob.finish((api) => api.call('slow', 'denied')), {
		error: 'FORBIDDEN_OR_GONE',
	})
	policy.get('bob').delete('read')
	assert.deepEqual(await createRun(bob).finish((api) => api.call('read', 'policy-revoked')), {
		error: 'FORBIDDEN_OR_GONE',
	})

	publicationOpen = false
	generation++
	publicationOpen = true
	const reused = createRun(bob)
	assert.deepEqual(await reused.finish((api) => api.call('read', 'old-generation')), {
		error: 'FORBIDDEN_OR_GONE',
	})
	const fresh = createSession('alice-2', 'alice', ['read', 'slow'])
	assert.equal((await createRun(fresh).finish((api) => api.call('read', 'fresh'))).generation, 2)
	const race = createSession('alice-race', 'alice', ['read'])
	const racing = createRun(race)
	const raceCall = racing.api.call('read', 'auth-race')
	await authEnteredPromise
	race.methods.delete('read')
	authRelease()
	assert.deepEqual(await raceCall, { error: 'FORBIDDEN_OR_GONE' })
	await racing.close()
	assert.equal(
		records.calls.some((item) => item.value === 'auth-race'),
		false,
	)

	const budget = createRun(fresh)
	await assert.rejects(budget.api.call('read', 'x'.repeat(MAX_INPUT_BYTES + 1)), /INPUT_BUDGET/)
	const budgetCalls = Array.from({ length: 3 }, (_, index) => budget.api.call('read', index))
	await assert.rejects(budget.api.call('read', 'over'), /CALL_BUDGET/)
	assert.equal((await Promise.all(budgetCalls)).length, 3)
	await budget.close()
	const unfinished = createRun(fresh)
	await assert.rejects(
		unfinished.finish(async (api) => {
			void api.call('slow', 'pending').catch(() => {})
			await pendingEnteredPromise
			setTimeout(pendingRelease, 30)
			return 'returned-with-work'
		}),
		/RUN_PENDING_CALLS/,
	)
	await wait(40)
	assert.equal(records.calls.filter((item) => item.value === 'pending').length, 1)
	const queueRun = createRun(fresh)
	const first = queueRun.api.call('slow', 'held')
	await slowStartedPromise
	assert.equal(slowStarted, true)
	const second = queueRun.api.call('read', 'queued-1')
	const third = queueRun.api.call('read', 'queued-2')
	await assert.rejects(queueRun.api.call('read', 'overflow'), /QUEUE_FULL/)
	let ownerStopped = false
	const stopping = stopOwner().then(() => (ownerStopped = true))
	await wait(10)
	assert.equal(ownerStopped, false, 'owner stop must wait for admitted work')
	slowRelease()
	pendingRelease()
	authRelease()
	await first
	await stopping
	assert.equal(ownerActive, 0)
	assert.deepEqual(await second, { error: 'FORBIDDEN_OR_GONE' })
	assert.deepEqual(await third, { error: 'FORBIDDEN_OR_GONE' })
	await queueRun.close()

	const dropped = createRun(fresh, { drop: 'before' })
	await assert.rejects(dropped.finish((api) => api.call('read', 'dropped')))
	assert.equal(
		records.calls.some((item) => item.value === 'dropped'),
		false,
	)
	assert.equal(records.requests.filter((item) => item.session === 'alice-2').length > 0, true)
	assert.equal(records.openedStubs, records.disposedStubs)
	console.log(
		JSON.stringify(
			{
				passed: [
					'http-session-binding',
					'revoke-and-policy-check',
					'generation-pin',
					'call-input-queue-budgets',
					'run-pending-calls',
					'owner-drain',
					'disconnect-no-replay',
					'stub-disposal',
				],
				requests: records.requests.length,
				calls: records.calls.length,
				rejections: records.rejections.length,
				stubs: { opened: records.openedStubs, disposed: records.disposedStubs },
			},
			null,
			2,
		),
	)
} finally {
	slowRelease()
	await new Promise((resolve) => server.close(resolve))
}
