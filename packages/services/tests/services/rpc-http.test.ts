import { createServer } from 'node:http'
import { defineCommand, Result } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import type { Context } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { newHttpBatchRpcSession, RpcTarget } from 'capnweb'
import { describe, expect, it } from 'vitest'
import { createRpcHttpCarrier } from '../../src/rpc/http'
import {
	RpcKernel,
	type RpcBuildPublication,
	type RpcCall,
	type RpcResult,
	type RpcKernelSession,
} from '../../src/rpc/kernel'

@Plugin({ displayName: 'HTTP RPC test publisher' })
class HttpRpcOwner extends BasePlugin {
	get owner(): Context {
		return this.ctx
	}
}

interface RemoteApi extends RpcTarget {
	invoke(call: { id: string; method: string; input: unknown; callId: string }): Promise<RpcResult>
}

function requestFor(
	url: string,
	run: { token: string; sessionId: string; runId: string },
	overrides: Record<string, string> = {},
) {
	return new Request(url, {
		headers: {
			authorization: `Bearer ${run.token}`,
			'x-session-id': run.sessionId,
			'x-run-id': run.runId,
			...overrides,
		},
	})
}

async function startCarrier(carrier: ReturnType<typeof createRpcHttpCarrier>) {
	const server = createServer((request, response) => {
		void carrier.handle(request, response).catch((error) => response.destroy(error))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected TCP address')
	return {
		url: `http://127.0.0.1:${address.port}/`,
		async close() {
			await carrier.close()
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

describe('private RPC HTTP carrier', () => {
	it('holds the real publisher owner through the HTTP reply finish', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(HttpRpcOwner).start(HttpRpcOwner)
		await host.commit()
		const command = defineCommand({
			name: 'notes.read',
			description: 'Read note.',
			input: obj({ text: Type.String() }),
			execute({ text }) {
				return Result.ok({ text })
			},
		})
		const built: RpcBuildPublication = {
			api: { id: 'notes', commands: { read: command } },
			bindings: { read: command },
			artifact: {
				format: 'pluxel-rpc-artifact-v1',
				integrity: 'a'.repeat(64),
				contract: { id: 'notes', hash: 'b'.repeat(64) },
				methods: [
					{
						method: 'read',
						command: command.name,
						description: command.descriptor.description,
						inputSchema: command.descriptor.inputSchema,
					},
				],
				types: [{ method: 'read', input: '{ text: string }', success: '{ text: string }' }],
				declaration: '// Trusted test artifact',
			},
		}
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>([
			[built.artifact, built.bindings],
		])
		const kernel = new RpcKernel(host.ctx, { verifyArtifact: (artifact) => trusted.get(artifact) })
		const publication = kernel.publish(host.require(HttpRpcOwner).owner, built)
		const session = kernel.createSession({
			principal: { id: 'alice' },
			access: [publication.contract],
		})
		const carrier = createRpcHttpCarrier()
		const run = carrier.openRun(session)
		let responseReady!: () => void
		const ready = new Promise<void>((resolve) => {
			responseReady = resolve
		})
		let releaseReply: (() => void) | undefined
		const server = createServer((request, response) => {
			const end = response.end.bind(response)
			response.end = ((body?: string) => {
				releaseReply = () => {
					end(body)
					releaseReply = undefined
				}
				responseReady()
				return response
			}) as typeof response.end
			void carrier.handle(request, response).catch((error) => response.destroy(error))
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Expected TCP address')
		const url = `http://127.0.0.1:${address.port}/`
		try {
			const stub = newHttpBatchRpcSession<RemoteApi>(requestFor(url, run))
			const call = Promise.resolve(
				stub.invoke({ id: 'notes', method: 'read', input: { text: 'hello' }, callId: 'owner-1' }),
			)
			await ready
			let stopped = false
			host.stop(HttpRpcOwner)
			const stopping = host.commit().then((): undefined => {
				stopped = true
				return undefined
			})
			await Promise.resolve()
			expect(stopped).toBe(false)
			releaseReply?.()
			expect(await call).toEqual({ ok: true, value: { text: 'hello' } })
			await stopping
			expect(stopped).toBe(true)
			stub[Symbol.dispose]()
		} finally {
			releaseReply?.()
			await run.close()
			await session.close()
			await carrier.close()
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	it('authenticates each run, bounds batches, and releases deliveries after HTTP completion', async () => {
		const calls: RpcCall[] = []
		let released = 0
		let observedRequests = 0
		const session = {
			async callForDelivery(input: RpcCall) {
				calls.push(input)
				return {
					result: { ok: true, value: { callId: input.callId } } as RpcResult,
					release() {
						released++
					},
				}
			},
		} as unknown as RpcKernelSession & {
			callForDelivery(input: RpcCall): Promise<{ result: RpcResult; release(): void }>
		}
		const carrier = createRpcHttpCarrier({ maxCallsPerBatch: 2, maxCallsPerRun: 3 }, () => {
			observedRequests++
			throw new Error('Observer failure must not change delivery')
		})
		const host = await startCarrier(carrier)
		try {
			const run = carrier.openRun(session)
			const stub = newHttpBatchRpcSession<RemoteApi>(requestFor(host.url, run))
			const [first, second] = await Promise.all([
				stub.invoke({ id: 'notes', method: 'read', input: { text: 'a' }, callId: 'a' }),
				stub.invoke({ id: 'notes', method: 'read', input: { text: 'b' }, callId: 'b' }),
			])
			expect(first).toEqual({ ok: true, value: { callId: 'a' } })
			expect(second).toEqual({ ok: true, value: { callId: 'b' } })
			expect(calls.map((call) => call.callId)).toEqual(['a', 'b'])
			expect(released).toBe(2)
			expect(run.stats()).toEqual({ admitted: 2, settled: 2, pendingRequests: 0 })
			stub[Symbol.dispose]()
			const duplicate = newHttpBatchRpcSession<RemoteApi>(requestFor(host.url, run))
			await expect(
				duplicate.invoke({ id: 'notes', method: 'read', input: {}, callId: 'a' }),
			).rejects.toThrow(/Invalid or duplicate RPC call/)
			expect(calls).toHaveLength(2)
			expect(observedRequests).toBe(2)
			duplicate[Symbol.dispose]()
			const unauthenticated = await fetch(host.url, { method: 'POST' })
			expect(unauthenticated.status).toBe(401)
			const wrongRun = await fetch(host.url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${run.token}`,
					'x-session-id': run.sessionId,
					'x-run-id': 'wrong',
				},
			})
			expect(wrongRun.status).toBe(401)
			await run.close()
			const closedRun = await fetch(host.url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${run.token}`,
					'x-session-id': run.sessionId,
					'x-run-id': run.runId,
				},
			})
			expect(closedRun.status).toBe(401)
			expect(observedRequests).toBe(2)
		} finally {
			await host.close()
		}
	})

	it('rejects oversized requests before dispatch', async () => {
		let entered = 0
		const session = {
			async callForDelivery() {
				entered++
				throw new Error('unreachable')
			},
		} as unknown as RpcKernelSession & {
			callForDelivery(input: RpcCall): Promise<{ result: RpcResult; release(): void }>
		}
		const carrier = createRpcHttpCarrier({ maxRequestBytes: 64 })
		const host = await startCarrier(carrier)
		try {
			const run = carrier.openRun(session)
			const response = await fetch(host.url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${run.token}`,
					'x-session-id': run.sessionId,
					'x-run-id': run.runId,
				},
				body: 'x'.repeat(128),
			})
			expect(response.status).toBe(413)
			expect(entered).toBe(0)
			const afterLimit = await fetch(host.url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${run.token}`,
					'x-session-id': run.sessionId,
					'x-run-id': run.runId,
				},
				body: '',
			})
			expect(afterLimit.status).toBe(401)
			await run.close()
		} finally {
			await host.close()
		}
	})

	it('closes a run when its HTTP reply exceeds the response budget', async () => {
		const session = {
			async callForDelivery() {
				return {
					result: { ok: true, value: { text: 'x'.repeat(256) } } as RpcResult,
					release() {},
				}
			},
		} as unknown as RpcKernelSession
		const carrier = createRpcHttpCarrier({ maxResponseBytes: 1 })
		const host = await startCarrier(carrier)
		try {
			const run = carrier.openRun(session)
			const stub = newHttpBatchRpcSession<RemoteApi>(requestFor(host.url, run))
			await expect(
				stub.invoke({ id: 'notes', method: 'read', input: {}, callId: 'large-reply' }),
			).rejects.toThrow(/.+/)
			stub[Symbol.dispose]()
			const afterLimit = await fetch(host.url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${run.token}`,
					'x-session-id': run.sessionId,
					'x-run-id': run.runId,
				},
				body: '',
			})
			expect(afterLimit.status).toBe(401)
			await run.close()
		} finally {
			await host.close()
		}
	})

	it('stops a run when one HTTP batch exceeds its call budget', async () => {
		let entered = 0
		const observed = new Map<string, 'not_started' | 'unknown'>()
		const session = {
			async callForDelivery() {
				entered++
				return { result: { ok: true, value: null } as RpcResult, release() {} }
			},
		} as unknown as RpcKernelSession & {
			callForDelivery(input: RpcCall): Promise<{ result: RpcResult; release(): void }>
		}
		const carrier = createRpcHttpCarrier({ maxCallsPerBatch: 2, maxCallsPerRun: 4 })
		const host = await startCarrier(carrier)
		try {
			const run = carrier.openRun(session, (callId, outcome) => observed.set(callId, outcome))
			const stub = newHttpBatchRpcSession<RemoteApi>(requestFor(host.url, run))
			const calls = await Promise.allSettled(
				['a', 'b', 'c'].map((callId) =>
					stub.invoke({ id: 'notes', method: 'read', input: {}, callId }),
				),
			)
			expect(calls.every((call) => call.status === 'rejected')).toBe(true)
			expect(entered).toBe(2)
			expect(run.stats().admitted).toBe(2)
			expect(observed).toEqual(
				new Map([
					['a', 'unknown'],
					['b', 'unknown'],
					['c', 'not_started'],
				]),
			)
			stub[Symbol.dispose]()
			await run.close()
		} finally {
			await host.close()
		}
	})

	it('waits for an admitted call after the client disconnects and the run closes', async () => {
		let entered!: () => void
		let releaseWork!: () => void
		const admitted = new Promise<void>((resolve) => (entered = resolve))
		const held = new Promise<void>((resolve) => (releaseWork = resolve))
		let released = 0
		const session = {
			async callForDelivery(input: RpcCall) {
				entered()
				await held
				return {
					result: { ok: true, value: input.callId } as RpcResult,
					release() {
						released++
					},
				}
			},
		} as unknown as RpcKernelSession & {
			callForDelivery(input: RpcCall): Promise<{ result: RpcResult; release(): void }>
		}
		const carrier = createRpcHttpCarrier({ drainMs: 2000 })
		const host = await startCarrier(carrier)
		try {
			const run = carrier.openRun(session)
			const abort = new AbortController()
			const stub = newHttpBatchRpcSession<RemoteApi>(
				new Request(host.url, {
					headers: {
						authorization: `Bearer ${run.token}`,
						'x-session-id': run.sessionId,
						'x-run-id': run.runId,
					},
					signal: abort.signal,
				}),
			)
			const call = Promise.resolve(
				stub.invoke({ id: 'notes', method: 'read', input: {}, callId: 'held' }),
			)
			void call.catch(() => {})
			await admitted
			abort.abort()
			let closed = false
			const closing = run.close().then((): undefined => {
				closed = true
				return undefined
			})
			await Promise.resolve()
			expect(closed).toBe(false)
			expect(run.stats().admitted).toBe(1)
			releaseWork()
			await closing
			expect(run.stats()).toEqual({ admitted: 1, settled: 1, pendingRequests: 0 })
			expect(released).toBe(1)
			stub[Symbol.dispose]()
		} finally {
			await host.close()
		}
	})

	it('enforces concurrent calls across separate HTTP batches in one run', async () => {
		const started = Promise.withResolvers<void>()
		const held = Promise.withResolvers<void>()
		let entered = 0
		const session = {
			async callForDelivery(input: RpcCall) {
				entered++
				started.resolve()
				await held.promise
				return { result: { ok: true, value: input.callId } as RpcResult, release() {} }
			},
		} as unknown as RpcKernelSession
		const carrier = createRpcHttpCarrier({
			maxCallsPerBatch: 1,
			maxConcurrentCalls: 1,
			maxCallsPerRun: 3,
		})
		const host = await startCarrier(carrier)
		const run = carrier.openRun(session)
		const firstStub = newHttpBatchRpcSession<RemoteApi>(requestFor(host.url, run))
		const secondStub = newHttpBatchRpcSession<RemoteApi>(requestFor(host.url, run))
		try {
			const first = Promise.resolve(
				firstStub.invoke({ id: 'notes', method: 'read', input: {}, callId: 'first' }),
			)
			void first.catch(() => {})
			await started.promise
			await expect(
				secondStub.invoke({ id: 'notes', method: 'read', input: {}, callId: 'second' }),
			).rejects.toBeInstanceOf(Error)
			expect(entered).toBe(1)
			expect(run.stats().admitted).toBe(1)
		} finally {
			held.resolve()
			firstStub[Symbol.dispose]()
			secondStub[Symbol.dispose]()
			await run.close()
			await host.close()
		}
	})
})
