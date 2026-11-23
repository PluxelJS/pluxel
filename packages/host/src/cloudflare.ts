import { assertDataObject } from './config-records'
import type { ApplicationEnvironment, PortableApplication } from './application'
import { captureEnv, startApplicationRoot, type HostInputs } from './embedded-application'
import type { CoreFacilitiesConfig, PluginConstructor } from '@pluxel/core'
import { snapshotVaultBindings, snapshotWorkerCoreFacilitiesConfig } from '@pluxel/core/internal'
import { createScriptScope } from './agent/sdk'
import type { PluginApplyReport } from './coordinator'
import type { ScriptSdk } from './agent/sdk-types'
import type { PluginHost } from './host'

export type { PluginHost } from './host'
export { defineHostService, type HostService, type HostServiceDependencies } from './services'
export { HostApplicationStartupError } from './application-start'

export type WorkerHostOptions = Pick<HostInputs, 'vaultBindings'>

type WorkerCoreConfig = Omit<CoreFacilitiesConfig, 'zenfs' | 'logtape' | 'vault' | 'http'> &
	Readonly<{
		zenfs?: never
		logtape?: never
		vault?: Readonly<{ backend?: 'bindings'; deployIdentity?: never; durable?: false }>
		http?: CoreFacilitiesConfig['http'] & Readonly<{ proxyUrl?: never; allowProxyChanges?: never }>
	}>

type Env = ApplicationEnvironment['env']
type EventContext = { waitUntil(promise: Promise<unknown>): void }
type EventOptions = Readonly<{
	env?: Env
	ctx: EventContext
	signal?: AbortSignal
	responseBody?: never
}>
type StreamingEventOptions = Readonly<{
	env?: Env
	ctx: EventContext
	signal: AbortSignal
	responseBody: 'scope'
}>

export interface WorkerHost extends AsyncDisposable {
	/** Borrow the resident application for this event. The callback owns one isolated script scope. */
	run<T>(event: EventOptions, run: (sdk: ScriptSdk) => T | Promise<T>): Promise<T>
	/** Keep the event scope until the body closes, errors, or is cancelled. */
	run(
		event: StreamingEventOptions,
		run: (sdk: ScriptSdk) => Response | Promise<Response>,
	): Promise<Response>
	/** Select the catalog for the accepted deployment after draining its events. Before startup, only publish the new references. */
	updateCatalog(
		select: (
			startup: ApplicationEnvironment,
		) => readonly PluginConstructor[] | Promise<readonly PluginConstructor[]>,
		options: { readonly onGraphCommitted: () => undefined },
	): Promise<PluginApplyReport | undefined>
	close(): Promise<void>
}

type Resident = {
	env: Env
	ready: Promise<PluginHost>
	host?: PluginHost
	events: Set<Promise<void>>
	retired: boolean
	closing?: Promise<void>
}

function untilAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return task
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener('abort', abort, { once: true })
		task.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				return resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

/** Create once in module scope. The first event starts the application inside a live I/O context. */
export function createWorkerHost(
	application: PortableApplication<WorkerCoreConfig>,
	options: WorkerHostOptions = {},
): WorkerHost {
	if (typeof application !== 'function') throw new TypeError('[host] Application must be a factory')
	assertDataObject(options, 'createWorkerHost options', ['vaultBindings'])
	const vaultBindings =
		options.vaultBindings === undefined ? undefined : snapshotVaultBindings(options.vaultBindings)
	const roots = new Set<Resident>()
	let current: Resident | undefined
	let pending: Resident | undefined
	let control: Promise<void> | undefined
	let shutdown: Promise<void> | undefined

	function destroy(root: Resident) {
		return (root.closing ??= root.ready
			.then(
				(host) => host.close(),
				() => {},
			)
			.finally(() => roots.delete(root)))
	}
	function retire(root: Resident, ctx: EventContext) {
		root.retired = true
		if (root.events.size === 0) ctx.waitUntil(destroy(root))
	}
	function deploymentEnv(input: Env | undefined) {
		const env = captureEnv(input, pending?.env ?? current?.env)
		return pending && env !== pending.env && current ? captureEnv(env, current.env) : env
	}
	function selectRoot(env: Env, ctx: EventContext) {
		if (pending?.env === env) return pending
		if (current?.env === env) return current
		const root: Resident = {
			env,
			events: new Set(),
			retired: false,
			ready: Promise.resolve().then(() =>
				startApplicationRoot(application, snapshotWorkerCoreFacilitiesConfig, env, vaultBindings),
			),
		}
		const previous = pending
		pending = root
		roots.add(root)
		if (previous) retire(previous, ctx)
		// Keep cold startup owned by its originating event even if that client disconnects.
		ctx.waitUntil(
			root.ready.then(
				(host): undefined => {
					root.host = host
					if (pending === root) {
						if (current) retire(current, ctx)
						current = root
						pending = undefined
					}
					return undefined
				},
				() => {
					if (pending === root) pending = undefined
					retire(root, ctx)
				},
			),
		)
		return root
	}

	// Each control operation closes admission synchronously. Rejected updates release the queue.
	function exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const task = (control ?? Promise.resolve()).then(operation)
		const clear = () => {
			if (control === barrier) control = undefined
		}
		const barrier = task.then(clear, clear)
		control = barrier
		return task
	}

	function run<T>(event: EventOptions, callback: (sdk: ScriptSdk) => T | Promise<T>): Promise<T>
	function run(
		event: StreamingEventOptions,
		callback: (sdk: ScriptSdk) => Response | Promise<Response>,
	): Promise<Response>
	async function run(
		event: EventOptions | StreamingEventOptions,
		callback: (sdk: ScriptSdk) => unknown,
	) {
		assertDataObject(event, 'WorkerHost.run event', ['env', 'ctx', 'signal', 'responseBody'])
		const { ctx, signal, responseBody } = event
		if (!ctx || typeof ctx.waitUntil !== 'function')
			throw new TypeError('[host] WorkerHost.run requires ctx.waitUntil')
		if (typeof callback !== 'function')
			throw new TypeError('[host] WorkerHost.run requires a callback')
		if (responseBody !== undefined && (responseBody !== 'scope' || !signal))
			throw new TypeError(
				'[host] A scope-owned response body requires responseBody "scope" and signal',
			)
		signal?.throwIfAborted()
		// Snapshot before queuing. A caller can reuse or mutate its projection after invoking run.
		let env = deploymentEnv(event.env)
		if (control) {
			do {
				if (shutdown) throw new Error('[host] WorkerHost is closed')
				await untilAbort(control, signal)
			} while (control)
			// Rejoin the deployment selected by the preceding event, including other queued waiters.
			env = deploymentEnv(env)
		}
		if (shutdown) throw new Error('[host] WorkerHost is closed')
		signal?.throwIfAborted()
		const root = selectRoot(env, ctx)
		const completion = Promise.withResolvers<void>()
		// A completion belongs to the event doing the I/O. workerd follows those promises across
		// contexts when a catalog update or shutdown drains several simultaneous requests.
		root.events.add(completion.promise)
		let scope: ReturnType<typeof createScriptScope> | undefined
		let retained = false
		async function releaseEvent() {
			try {
				await using _lease = {
					async [Symbol.asyncDispose]() {
						root.events.delete(completion.promise)
						if (root.retired && root.events.size === 0) await destroy(root)
					},
				}
				await scope?.dispose()
			} finally {
				completion.resolve()
			}
		}
		await using _event = {
			async [Symbol.asyncDispose]() {
				if (!retained) await releaseEvent()
			},
		}
		ctx.waitUntil(completion.promise)
		const host = root.host ?? (await untilAbort(root.ready, signal))
		signal?.throwIfAborted()
		scope = createScriptScope({ ctx: host.ctx, signal })
		const result = await callback(scope.sdk)
		if (responseBody !== 'scope') return result
		if (!(result instanceof Response)) throw new TypeError('[host] Expected a streaming Response')
		if (!result.body) return result
		const response = retainResponseBody(
			result,
			result.body,
			{ ctx, signal },
			{ close: releaseEvent, abort: scope.abort },
		)
		retained = true
		return response
	}

	function close() {
		return (shutdown ??= exclusive(async () => {
			const results = await Promise.allSettled(
				[...roots].map(async (root) => {
					root.retired = true
					await Promise.all(root.events)
					await destroy(root)
				}),
			)
			current = pending = undefined
			const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
			if (failures.length > 0) throw new AggregateError(failures, '[host] Worker shutdown failed')
		}))
	}

	return {
		run,
		async updateCatalog(select, { onGraphCommitted }) {
			if (shutdown) throw new Error('[host] WorkerHost is closed')
			if (typeof select !== 'function' || typeof onGraphCommitted !== 'function')
				throw new TypeError(
					'[host] Worker catalog updates require select and onGraphCommitted callbacks',
				)
			return exclusive(async () => {
				await Promise.all(Array.from(roots, (root) => Promise.all(root.events)))
				// Aborting the last cold waiter leaves its boot alive under waitUntil.
				if (pending) await pending.ready.catch(() => {})
				if (current) {
					const plugins = await select(Object.freeze({ env: current.env }))
					return current.host!.updateCatalog(plugins, { onGraphCommitted })
				}
				onGraphCommitted()
				return undefined
			})
		},
		close,
		[Symbol.asyncDispose]: close,
	}
}

function retainResponseBody(
	response: Response,
	body: ReadableStream<Uint8Array>,
	{ signal, ctx }: Pick<StreamingEventOptions, 'signal' | 'ctx'>,
	lifetime: { close(): Promise<void>; abort(reason?: unknown): void },
): Response {
	const reader = body.getReader()
	let output: ReadableStreamDefaultController<Uint8Array>
	let settlement: Promise<void> | undefined
	let cancelled = false
	const abort = () => {
		cancelled = true
		output.error(signal.reason)
		ctx.waitUntil(settle(true, signal.reason))
	}
	const settle = (cancel: boolean, reason?: unknown): Promise<void> =>
		(settlement ??= (async () => {
			signal.removeEventListener('abort', abort)
			try {
				if (cancel) {
					lifetime.abort(reason)
					await reader.cancel(reason)
				}
			} finally {
				reader.releaseLock()
				await lifetime.close()
			}
		})())
	const wrapped = new Response(
		new ReadableStream<Uint8Array>(
			{
				start(controller) {
					output = controller
				},
				async pull(controller) {
					let chunk: ReadableStreamReadResult<Uint8Array>
					try {
						chunk = await reader.read()
					} catch (error) {
						await using _lifetime = { [Symbol.asyncDispose]: () => settle(false) }
						throw error
					}
					if (cancelled) return
					if (chunk.done) {
						await settle(false)
						if (!cancelled) controller.close()
					} else {
						controller.enqueue(chunk.value)
					}
				},
				cancel(reason) {
					cancelled = true
					return settle(true, reason)
				},
			},
			{ highWaterMark: 0 },
		),
		response,
	)
	signal.addEventListener('abort', abort, { once: true })
	if (signal.aborted) abort()
	return wrapped
}
