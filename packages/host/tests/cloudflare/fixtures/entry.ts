import { defineHostApplication } from '@pluxel/host/application'
import { envBinding, InputBindingError } from '@pluxel/host/bindings'
import { createWorkerHost } from '@pluxel/host/cloudflare'
import * as v from 'valibot'
import { RequestConsumer } from './consumer'
import { ExtraProvider, RequestProvider } from './provider'

type Env = Record<'LEFT' | 'RIGHT', { fetch(request: Request): Promise<Response> }> &
	Record<'HOST_PROBE' | 'NEXT_PROBE', string>
type WorkerContext = { waitUntil(promise: Promise<unknown>): void }

const settled: Record<string, { calls: number; cancelled: boolean }> = {}
let stops = 0
let revision = 0
let thirdFetchStarted = false

async function barrier(path: string) {
	const response = await fetch('https://coordination.test/' + path)
	await response.text()
}

const application = defineHostApplication(() => ({
	plugins: [
		{
			plugin: RequestProvider,
			envBindings: [
				envBinding({
					vault: { schema: v.object({ probe: v.string() }), mapping: { probe: 'HOST_PROBE' } },
				}),
			],
		},
		{ plugin: RequestConsumer, autoStart: true },
	],
	services: [
		{
			name: 'startup barrier',
			provides: [],
			async prepare({ effects }) {
				await barrier('prepare')
				effects.defer(() => {
					stops++
				})
			},
		},
	],
	coreConfig: {
		http: {
			allowedOrigins: ['https://backend.test'],
			maxConcurrentRequests: 1,
			headers: { 'x-fixture': 'managed-fetch' },
			records: 'off',
		},
	},
}))
const worker = createWorkerHost(application)

function load(request: Request, env: Env, ctx: WorkerContext, id: string) {
	// Select fixed test deployment inputs without copying native event bindings into a root.
	const deployment = {
		HOST_PROBE:
			id === 'vault-next' ? env.NEXT_PROBE : id === 'vault-missing' ? undefined : env.HOST_PROBE,
	}
	if (id === 'boot-abort') {
		const controller = new AbortController()
		ctx.waitUntil(barrier('cancel-start').then(() => controller.abort()))
		return worker
			.run({ env: deployment, signal: controller.signal, ctx }, () => {
				throw new Error('Cancelled cold callback was admitted')
			})
			.catch((error: unknown) => {
				if (error !== controller.signal.reason) throw error
				return new Response(null, { status: 499 })
			})
	}
	const reply = worker.run({ env: deployment, signal: request.signal, ctx }, async (sdk) => {
		if (id.startsWith('vault-')) {
			const { instance } = await sdk.plugin(RequestProvider.nodeAddress()).instance()
			const before = await instance.deploymentProbe()
			if (id !== 'vault-hold') return Response.json(before)
			await barrier('hold-vault')
			return Response.json({ before, after: await instance.deploymentProbe() })
		}
		const admittedRevision = revision
		const { instance } = await sdk.plugin(RequestConsumer.nodeAddress()).instance()
		if (id === 'cancelled') return Response.json(await instance.checkCancelledFetch(id))
		const backend = request.headers.get('x-binding') === 'right' ? env.RIGHT : env.LEFT
		const loaded = instance.load(id, request.signal)
		if (id === 'third') thirdFetchStarted = true
		return Response.json({
			...(await loaded),
			revision: admittedRevision,
			event: await instance.echo(request, backend),
			nodeGlobals: typeof process !== 'undefined' || typeof Buffer !== 'undefined',
		})
	})
	if (id === 'vault-missing')
		return reply.catch((error: unknown) => {
			if (error instanceof InputBindingError && error.code === 'MISSING_INPUT')
				return Response.json({ code: error.code }, { status: 422 })
			throw error
		})
	if (id === 'second') ctx.waitUntil(barrier('admitted'))
	if (id === 'after-update') ctx.waitUntil(barrier('queued'))
	return reply
}

function stream(request: Request, bindings: Env, ctx: WorkerContext, id: string) {
	const env = { HOST_PROBE: bindings.HOST_PROBE }
	const event = { env, signal: request.signal, ctx, responseBody: 'scope' as const }
	const response = worker.run(event, async (sdk) => {
		let cancelled = false
		sdk.ctx.effects.defer(() => {
			settled[id] = { calls: (settled[id]?.calls ?? 0) + 1, cancelled }
		})
		const { instance } = await sdk.plugin(RequestConsumer.nodeAddress()).instance()
		const text = new TextEncoder()
		let chunks = 0
		return new Response(
			new ReadableStream<Uint8Array>(
				{
					start(output) {
						output.enqueue(text.encode('ready: '))
					},
					async pull(output) {
						if (id === 'stream-abort') {
							await new Promise((resolve) => setTimeout(resolve, 40))
							output.enqueue(text.encode('waiting\n'))
							if (++chunks === 50) output.close()
							return
						}
						if (id === 'stream-error') throw new Error('fixture stream failed')
						if (id === 'stream-hold') await barrier('hold-stream')
						const reply = await instance.load(id, request.signal)
						output.enqueue(text.encode(reply.value))
						output.close()
					},
					cancel() {
						cancelled = true
					},
				},
				{ highWaterMark: 0 },
			),
			{ headers: { 'Content-Type': 'text/plain' } },
		)
	})
	if (id === 'stream-complete') {
		// Reusing the options after admission must preserve this stream's lease and original signal.
		Object.assign(event, { responseBody: undefined, signal: AbortSignal.abort() })
	}
	return response
}

export default {
	async fetch(request: Request, env: Env, ctx: WorkerContext) {
		const id = new URL(request.url).pathname.slice(1)
		if (id === 'settled') return Response.json(settled)
		if (id === 'admission') return Response.json(thirdFetchStarted)
		if (id === 'update') {
			let settledBeforeCommit = 0
			const change = worker.updateCatalog(() => [RequestProvider, RequestConsumer, ExtraProvider], {
				onGraphCommitted() {
					revision++
					settledBeforeCommit = settled['stream-hold']?.calls ?? 0
				},
			})
			ctx.waitUntil(barrier('updating'))
			const report = await change
			return Response.json({ catalogRevision: report?.catalogRevision, settledBeforeCommit })
		}
		if (id === 'close') {
			await worker.close()
			await worker.close()
			return Response.json({ stops })
		}
		if (id.startsWith('stream-')) return stream(request, env, ctx, id)
		return load(request, env, ctx, id)
	},
}
