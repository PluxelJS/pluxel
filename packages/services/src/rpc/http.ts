import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { newHttpBatchRpcResponse, RpcTarget } from 'capnweb'
import type { RpcKernelSession, RpcResult } from './kernel'

type Limits = Readonly<{
	maxRequestBytes: number
	maxBodyMs: number
	maxBatchMessages: number
	maxCallsPerBatch: number
	maxConcurrentCalls: number
	maxCallsPerRun: number
	maxResponseBytes: number
	drainMs: number
}>

const defaultLimits: Limits = Object.freeze({
	maxRequestBytes: 65_536,
	maxBodyMs: 2_000,
	maxBatchMessages: 32,
	maxCallsPerBatch: 4,
	maxConcurrentCalls: 4,
	maxCallsPerRun: 16,
	maxResponseBytes: 1_048_576,
	drainMs: 5_000,
})

type Run = {
	readonly session: RpcKernelSession
	readonly sessionId: string
	readonly runId: string
	readonly token: string
	readonly abort: AbortController
	readonly callIds: Set<string>
	readonly pending: Set<Promise<void>>
	readonly failures: unknown[]
	readonly onCall?: (callId: string, outcome: 'not_started' | 'unknown') => void
	open: boolean
	admitted: number
	settled: number
	activeCalls: number
	closing?: Promise<void>
}

export type RpcHttpRun = Readonly<{
	sessionId: string
	runId: string
	token: string
	seal(): void
	close(): Promise<void>
	waitForSettled(): Promise<void>
	stats(): Readonly<{ admitted: number; settled: number; pendingRequests: number }>
}>

/** Internal Node HTTP carrier. The trusted host supplies an already-authorized session. */
export function createRpcHttpCarrier(config: Partial<Limits> = {}, onRequest?: () => void) {
	const limits = {
		...defaultLimits,
		...config,
		maxConcurrentCalls:
			config.maxConcurrentCalls ?? config.maxCallsPerBatch ?? defaultLimits.maxConcurrentCalls,
	}
	for (const value of Object.values(limits)) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new TypeError('RPC HTTP limits must be positive integers')
	}
	if (
		limits.maxCallsPerBatch > limits.maxCallsPerRun ||
		limits.maxConcurrentCalls > limits.maxCallsPerRun
	)
		throw new TypeError('RPC batch exceeds run call limit')
	const runs = new Map<string, Run>()
	let open = true

	async function closeRun(run: Run): Promise<void> {
		if (run.closing) return run.closing
		run.open = false
		run.abort.abort(new Error('RPC run closed'))
		run.closing = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				const outcomes = await Promise.race([
					Promise.allSettled(run.pending),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('RPC HTTP run did not drain')),
							limits.drainMs,
						)
					}),
				])
				const failures = [
					...run.failures,
					...outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : [])),
				]
				if (failures.length > 0) throw new AggregateError(failures, 'RPC HTTP run cleanup failed')
				runs.delete(run.token)
			} finally {
				clearTimeout(timer)
			}
		})()
		return run.closing
	}

	function openRun(
		session: RpcKernelSession,
		onCall?: (callId: string, outcome: 'not_started' | 'unknown') => void,
	): RpcHttpRun {
		if (!open) throw new Error('RPC HTTP carrier closed')
		if (typeof session?.callForDelivery !== 'function')
			throw new TypeError('RPC session requires delivery lease support')
		const run: Run = {
			session,
			sessionId: randomBytes(16).toString('hex'),
			runId: randomBytes(16).toString('hex'),
			token: randomBytes(32).toString('hex'),
			abort: new AbortController(),
			callIds: new Set(),
			pending: new Set(),
			failures: [],
			onCall,
			open: true,
			admitted: 0,
			settled: 0,
			activeCalls: 0,
		}
		runs.set(run.token, run)
		return Object.freeze({
			sessionId: run.sessionId,
			runId: run.runId,
			token: run.token,
			seal: () => {
				run.open = false
			},
			close: () => closeRun(run),
			waitForSettled: async () => {
				await Promise.allSettled(run.pending)
			},
			stats: () =>
				Object.freeze({
					admitted: run.admitted,
					settled: run.settled,
					pendingRequests: run.pending.size,
				}),
		})
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const authorization = request.headers.authorization
		const token =
			typeof authorization === 'string' && authorization.startsWith('Bearer ')
				? authorization.slice(7)
				: ''
		const run = runs.get(token)
		if (
			!run?.open ||
			request.headers['x-run-id'] !== run.runId ||
			request.headers['x-session-id'] !== run.sessionId
		) {
			await reply(response, 401, 'Unauthorized')
			return
		}
		if (request.method !== 'POST') {
			await reply(response, 405, 'POST required')
			return
		}
		try {
			onRequest?.()
		} catch {
			// Observation cannot change RPC delivery.
		}
		const task = serve(run, request, response)
		run.pending.add(task)
		try {
			await task
		} catch (cause) {
			run.failures.push(cause)
			throw cause
		} finally {
			run.pending.delete(task)
		}
	}

	async function serve(
		run: Run,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const requestAbort = new AbortController()
		const onDisconnect = () => {
			if (!response.writableFinished) requestAbort.abort(new Error('RPC client disconnected'))
		}
		response.once('close', onDisconnect)
		const releases: Array<() => void> = []
		const callTasks = new Set<Promise<RpcResult>>()
		try {
			const body = await readBody(request, limits.maxRequestBytes, limits.maxBodyMs)
			const messageCount = body.length === 0 ? 0 : body.split('\n').length
			if (messageCount > limits.maxBatchMessages) {
				run.open = false
				run.abort.abort(new Error('RPC batch message limit exceeded'))
				await reply(response, 413, 'RPC batch message limit exceeded')
				return
			}
			const signal = AbortSignal.any([run.abort.signal, requestAbort.signal])
			let batchCalls = 0
			async function dispatch(candidate: unknown): Promise<RpcResult> {
				if (!candidate || typeof candidate !== 'object') throw new TypeError('Invalid RPC call')
				const call = candidate as Record<string, unknown>
				if (
					typeof call.id !== 'string' ||
					typeof call.method !== 'string' ||
					typeof call.callId !== 'string' ||
					!/^[A-Za-z0-9_.:-]{1,128}$/.test(call.callId) ||
					run.callIds.has(call.callId)
				) {
					throw new TypeError('Invalid or duplicate RPC call')
				}
				run.callIds.add(call.callId)
				run.onCall?.(call.callId, 'not_started')
				if (!run.open || signal.aborted) throw new Error('RPC run closed')
				if (
					batchCalls >= limits.maxCallsPerBatch ||
					run.admitted >= limits.maxCallsPerRun ||
					run.activeCalls >= limits.maxConcurrentCalls
				) {
					run.open = false
					run.abort.abort(new Error('RPC call limit exceeded'))
					throw new Error('RPC call limit exceeded')
				}
				batchCalls++
				run.admitted++
				run.activeCalls++
				// The kernel may enter Command.execute synchronously before returning its Promise.
				run.onCall?.(call.callId, 'unknown')
				try {
					const delivery = await run.session.callForDelivery({
						id: call.id,
						method: call.method,
						input: call.input,
						callId: call.callId,
						signal,
					})
					releases.push(delivery.release)
					return transportDto(delivery.result, call.callId)
				} finally {
					run.settled++
					run.activeCalls--
				}
			}
			class RunTarget extends RpcTarget {
				invoke(candidate: unknown): Promise<RpcResult> {
					const task = dispatch(candidate)
					callTasks.add(task)
					void task.then(
						() => callTasks.delete(task),
						() => callTasks.delete(task),
					)
					return task
				}
			}
			const capnResponse = await newHttpBatchRpcResponse(
				new Request('http://localhost/rpc', { method: 'POST', body }),
				new RunTarget(),
			)
			const text = await capnResponse.text()
			if (Buffer.byteLength(text, 'utf8') > limits.maxResponseBytes) {
				run.open = false
				run.abort.abort(new Error('RPC response limit exceeded'))
				await reply(response, 500, 'RPC response limit exceeded')
			} else if (!response.destroyed && run.abort.signal.aborted) {
				await reply(response, 409, 'RPC run closed')
			} else if (!response.destroyed) {
				await reply(response, capnResponse.status, text, {
					'content-type': 'text/plain; charset=utf-8',
				})
			}
		} catch (cause) {
			run.open = false
			run.abort.abort(cause)
			if (!response.destroyed) {
				const status = cause instanceof BodyLimitError ? 413 : 400
				await reply(
					response,
					status,
					status === 413 ? 'RPC request limit exceeded' : 'Invalid RPC request',
				)
			}
		} finally {
			response.off('close', onDisconnect)
			await Promise.allSettled(callTasks)
			const releaseFailures: unknown[] = []
			for (const release of releases.toReversed()) {
				try {
					release()
				} catch (cause) {
					releaseFailures.push(cause)
				}
			}
			if (releaseFailures.length > 0)
				run.failures.push(new AggregateError(releaseFailures, 'RPC delivery release failed'))
		}
	}

	async function close(): Promise<void> {
		open = false
		const outcomes = await Promise.allSettled([...runs.values()].map(closeRun))
		const failures = outcomes.flatMap((outcome) =>
			outcome.status === 'rejected' ? [outcome.reason] : [],
		)
		if (failures.length > 0) throw new AggregateError(failures, 'RPC HTTP carrier cleanup failed')
	}

	return Object.freeze({ openRun, handle, close })
}

class BodyLimitError extends Error {}

/** Kernel DTOs use null-prototype objects; Cap'n Web only accepts Object.prototype records. */
function transportDto(result: RpcResult, callId: string): RpcResult {
	try {
		if (Object.keys(Object.prototype).length > 0)
			throw new TypeError('RPC transport prototype is polluted')
		let nodes = 0
		const copy = (value: unknown, depth: number): unknown => {
			if (++nodes > 10_000 || depth > 32) throw new TypeError('RPC transport DTO limit exceeded')
			if (
				value === null ||
				typeof value === 'string' ||
				typeof value === 'boolean' ||
				(typeof value === 'number' && Number.isFinite(value))
			)
				return value
			if (Array.isArray(value)) return value.map((item) => copy(item, depth + 1))
			if (!value || typeof value !== 'object') throw new TypeError('Invalid RPC transport DTO')
			const prototype = Object.getPrototypeOf(value)
			if (prototype !== null && prototype !== Object.prototype)
				throw new TypeError('Invalid RPC transport DTO')
			const plain: Record<string, unknown> = {}
			for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
				if (key === '__proto__' || !descriptor.enumerable || !('value' in descriptor))
					throw new TypeError('Invalid RPC transport DTO key')
				Object.defineProperty(plain, key, {
					value: copy(descriptor.value, depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			return plain
		}
		return copy(result, 0) as RpcResult
	} catch {
		return {
			ok: false,
			error: {
				code: 'OUTPUT_ENCODING',
				message: 'RPC output cannot be delivered',
				callId,
				outcome: 'unknown',
			},
		}
	}
}

async function readBody(
	request: IncomingMessage,
	maxBytes: number,
	maxBodyMs: number,
): Promise<string> {
	const declared = Number(request.headers['content-length'])
	if (Number.isFinite(declared) && declared > maxBytes) throw new BodyLimitError()
	const chunks: Buffer[] = []
	let size = 0
	const timer = setTimeout(() => request.destroy(new BodyLimitError()), maxBodyMs)
	try {
		for await (const chunk of request) {
			size += chunk.length
			if (size > maxBytes) throw new BodyLimitError()
			chunks.push(chunk)
		}
	} finally {
		clearTimeout(timer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function reply(
	response: ServerResponse,
	status: number,
	body: string,
	headers: Record<string, string> = {},
): Promise<void> {
	if (response.destroyed || response.writableEnded) return
	await new Promise<void>((resolve) => {
		const done = () => {
			response.off('finish', done)
			response.off('close', done)
			resolve()
		}
		response.once('finish', done)
		response.once('close', done)
		response.writeHead(status, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		})
		response.end(body)
	})
}
