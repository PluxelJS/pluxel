import wretch, { type Wretch } from 'wretch'
import type { Dispatcher } from 'undici'
import type { Context, RootContext } from '../context/Context'
import { enterOwnerInvocation } from '../internal/owner-invocations'
import { requireHostDocuments } from '../internal/storage'
import { OUTBOUND_HTTP_LOG_STREAM_ID } from '../logging/protocol'
import { RuntimeLogStore } from '../logging/store'
import {
	comparePluginNodeAddress,
	formatPluginNodeReference,
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '../plugins/runtime/identity'
import type { HostDocumentStorage } from '../storage/documents'
import { OutboundHttpError, RequestAdmission } from './admission'
import {
	normalizeOutboundHttpSettings,
	type ResolvedManagedOutboundHttpOptions,
	type ResolvedOutboundHttpOptions,
} from './options'
import {
	compileOutboundHttpPolicy,
	parseOutboundHttpPolicy,
	serializeOutboundHttpPolicy,
	type OutboundHttpPolicy,
} from './policy'
import type {
	ManagedOutboundHttpSnapshot,
	OutboundFetch,
	OutboundHttpActivity,
	OutboundHttpSettings,
	OutboundHttpSnapshot,
} from './types'

const policyKey = 'policy.json'
const emptySettings = Object.freeze({})
const redirectStatuses = new Set([301, 302, 303, 307, 308])
type NodeRequestInit = RequestInit & { dispatcher?: Dispatcher }
type ProxyResource = { dispatcher: Dispatcher; active: number; notifyIdle?: () => void }
type Dispatchers = ReadonlyMap<string, ProxyResource>

type Client = { fetch: OutboundFetch; wretch?: Wretch }
type Applied = ReturnType<typeof compileOutboundHttpPolicy> & { dispatchers: Dispatchers }
type Caller = {
	address: PluginNodeAddress
	key: string
	log?: { name: string; pluginReference: string }
}

/** A committed settings change may still be waiting for retired connections to drain. */
export type OutboundHttpCommit = Readonly<{
	snapshot: ManagedOutboundHttpSnapshot
	cleanup: Promise<string | undefined>
}>

type OutboundHttpManagement = Readonly<{
	logs?: RuntimeLogStore
	snapshot(owner: PluginNodeAddress | null): Promise<OutboundHttpSnapshot>
	save(
		owner: PluginNodeAddress | null,
		expectedRevision: number,
		input: unknown,
	): Promise<OutboundHttpCommit>
}>

export function createOutboundHttpRuntime(root: RootContext, options: ResolvedOutboundHttpOptions) {
	const managed = options.managed ? new ManagedOutboundHttpRuntime(root, options) : undefined
	const clients = new WeakMap<Context, Client>()
	const management: OutboundHttpManagement =
		managed?.management ??
		Object.freeze({
			async snapshot(owner: PluginNodeAddress | null): Promise<OutboundHttpSnapshot> {
				return Object.freeze({
					managed: false,
					owner: owner === null ? null : parsePluginNodeAddress(owner),
				})
			},
			async save(): Promise<never> {
				throw new OutboundHttpError(
					'management_disabled',
					'Outbound HTTP management is disabled by the Host',
				)
			},
		})

	function clientFor(owner: Context): Client {
		if (owner.root !== root) throw new TypeError('[core.http] the owner belongs to another Host')
		const present = clients.get(owner)
		if (present) return present
		const address = owner.pluginInfo?.nodeAddress
		if (!address) throw new TypeError('[core.http] a Plugin node address is required')
		const fetch = managed ? managed.bind(owner, address) : bindUnmanagedFetch(owner, options.fetch)
		const client = { fetch }
		clients.set(owner, client)
		return client
	}
	return {
		management,
		async clearNode(owner: PluginNodeAddress) {
			if (managed) return await managed.clearNode(owner)
			// A fork removed while policy is inactive must not inherit it when recreated later.
			const documents = requireHostDocuments(root, 'outbound-http')
			const policy = parseOutboundHttpPolicy(await documents.getText(policyKey))
			const key = pluginNodeIndexKey(owner)
			if (!policy.nodes.has(key)) return
			const nodes = new Map(policy.nodes)
			nodes.delete(key)
			await documents.put(
				policyKey,
				serializeOutboundHttpPolicy({
					...policy,
					revision: nextPolicyRevision(policy),
					nodes,
				}),
			)
		},
		fetchFor: (owner: Context) => clientFor(owner).fetch,
		wretchFor(owner: Context): Wretch {
			const client = clientFor(owner)
			return (client.wretch ??= wretch().fetchPolyfill(client.fetch))
		},
	}
}

export type OutboundHttpRuntime = ReturnType<typeof createOutboundHttpRuntime>

class ManagedOutboundHttpRuntime {
	private readonly activity?: Map<string, OutboundHttpActivity>
	private readonly logs?: RuntimeLogStore
	private readonly resources = new Set<ProxyResource>()
	private readonly retirements = new Set<Promise<string | undefined>>()
	private readonly admission: RequestAdmission
	private readonly shutdown = new AbortController()
	private restored?: Promise<Applied>
	private applied?: Applied
	private documents?: HostDocumentStorage
	private writeTail: Promise<void> = Promise.resolve()
	private writeFault?: Error
	readonly management: OutboundHttpManagement

	constructor(
		private readonly root: RootContext,
		private readonly options: ResolvedManagedOutboundHttpOptions,
	) {
		const { maxConcurrentRequests, maxQueuedRequests } = options.limits
		this.admission = new RequestAdmission(maxConcurrentRequests, maxQueuedRequests)
		if (options.records !== 'off') this.activity = new Map()
		if (options.records === 'requests') {
			this.logs = new RuntimeLogStore({
				streamId: OUTBOUND_HTTP_LOG_STREAM_ID,
				windowLines: 5_000,
			})
		}
		this.management = Object.freeze({
			logs: this.logs,
			snapshot: (owner: PluginNodeAddress | null) => this.snapshot(owner),
			save: (owner: PluginNodeAddress | null, expectedRevision: number, input: unknown) =>
				this.save(owner, expectedRevision, input),
		})
		root.effects.defer(() => this.dispose(), { tag: 'OutboundHTTP', phase: 'shutdown' })
	}

	bind(owner: Context, address: PluginNodeAddress): OutboundFetch {
		const caller: Caller = { address, key: pluginNodeIndexKey(address) }
		if (this.logs) {
			const name = owner.pluginInfo?.displayName ?? address.definition.exportName
			caller.log = {
				name: address.variant === 'fork' ? `${name} · ${address.forkId}` : name,
				pluginReference: formatPluginNodeReference(address),
			}
		}
		return bindOwnerFetch(
			owner,
			(input, init, lifetime) => this.send(caller, input, init, lifetime),
			this.shutdown.signal,
		)
	}

	private async snapshot(owner: PluginNodeAddress | null): Promise<OutboundHttpSnapshot> {
		const address = owner === null ? null : parsePluginNodeAddress(owner)
		return this.describe(await this.current(), address)
	}

	private async save(
		owner: PluginNodeAddress | null,
		expectedRevision: number,
		input: unknown,
	): Promise<OutboundHttpCommit> {
		const address = owner === null ? null : parsePluginNodeAddress(owner)
		const settings = input === null ? null : normalizeOutboundHttpSettings(input)
		return this.enqueue(async () => {
			const applied = await this.current()
			if (expectedRevision !== applied.policy.revision)
				throw new OutboundHttpError(
					'revision_conflict',
					'Outbound HTTP settings changed since they were read',
				)
			return await this.commit(applied, address, settings)
		})
	}

	async clearNode(owner: PluginNodeAddress): Promise<void> {
		const key = pluginNodeIndexKey(owner)
		await this.enqueue(async () => {
			const applied = await this.current()
			if (applied.policy.nodes.has(key)) await this.commit(applied, owner, null)
			this.activity?.delete(key)
		})
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		this.shutdown.signal.throwIfAborted()
		const pending = this.writeTail.then(operation)
		this.writeTail = pending.then(
			(): void => undefined,
			(): void => undefined,
		)
		return pending
	}

	private async current(signal?: AbortSignal): Promise<Applied> {
		this.shutdown.signal.throwIfAborted()
		signal?.throwIfAborted()
		if (this.applied) return this.applied
		this.restored ??= Promise.resolve().then(() => this.restore())
		const applied = await (signal ? waitForPolicy(this.restored, signal) : this.restored)
		this.shutdown.signal.throwIfAborted()
		return applied
	}

	private async restore(): Promise<Applied> {
		try {
			this.documents = requireHostDocuments(this.root, 'outbound-http')
			const applied = await this.prepare(
				parseOutboundHttpPolicy(await this.documents.getText(policyKey)),
			)
			this.applied = applied
			return applied
		} catch (cause) {
			throw new Error('[core.http] cannot restore outbound-http/' + policyKey, { cause })
		}
	}

	private describe(applied: Applied, owner: PluginNodeAddress | null): ManagedOutboundHttpSnapshot {
		const { policy, host, nodes } = applied
		const key = owner === null ? undefined : pluginNodeIndexKey(owner)
		const seen = key === undefined ? undefined : this.activity?.get(key)
		return Object.freeze({
			managed: true,
			records: this.options.records,
			revision: policy.revision,
			owner,
			settings:
				key === undefined ? policy.defaults : (policy.nodes.get(key)?.settings ?? emptySettings),
			effective: (key === undefined ? host : (nodes.get(key) ?? host)).effective,
			limits: this.options.limits,
			activity: Object.freeze(
				key === undefined
					? [...(this.activity?.values() ?? [])].sort((a, b) =>
							comparePluginNodeAddress(a.owner, b.owner),
						)
					: seen
						? [seen]
						: [],
			),
		})
	}

	private async prepare(
		policy: OutboundHttpPolicy,
		borrowed: Dispatchers = new Map(),
	): Promise<Applied> {
		const compiled = compileOutboundHttpPolicy(this.options, policy)
		const dispatchers = new Map<string, ProxyResource>()
		const { createProxyDispatcher } = this.options
		if (!createProxyDispatcher) return { ...compiled, dispatchers }
		const acquired: ProxyResource[] = []
		const proxies = new Set([
			compiled.host.effective.proxyUrl,
			...[...compiled.nodes.values()].map(({ effective }) => effective.proxyUrl),
		])
		try {
			for (const url of proxies) {
				if (url === null) continue
				const existing = borrowed.get(url)
				if (existing) {
					dispatchers.set(url, existing)
					continue
				}
				const proxy = { dispatcher: await createProxyDispatcher(url), active: 0 }
				acquired.push(proxy)
				this.resources.add(proxy)
				dispatchers.set(url, proxy)
			}
			return { ...compiled, dispatchers }
		} catch (error) {
			return this.releaseCandidate(acquired, error)
		}
	}

	private async commit(
		applied: Applied,
		owner: PluginNodeAddress | null,
		settings: OutboundHttpSettings | null,
	): Promise<OutboundHttpCommit> {
		if (this.writeFault) throw this.writeFault
		const key = owner === null ? undefined : pluginNodeIndexKey(owner)
		const previous =
			key === undefined ? applied.policy.defaults : applied.policy.nodes.get(key)?.settings
		if (
			!this.options.limits.allowProxyChanges &&
			settings?.proxyUrl !== undefined &&
			settings.proxyUrl !== previous?.proxyUrl
		)
			throw new TypeError('[core.http] managed proxy selection is locked by the Host')

		const nodes = new Map(applied.policy.nodes)
		if (owner !== null && key !== undefined) {
			if (settings === null) nodes.delete(key)
			else nodes.set(key, { owner, settings })
		}
		const policy: OutboundHttpPolicy = {
			revision: nextPolicyRevision(applied.policy),
			defaults: owner === null ? (settings ?? emptySettings) : applied.policy.defaults,
			nodes,
		}
		const next = await this.prepare(policy, applied.dispatchers)
		try {
			this.shutdown.signal.throwIfAborted()
			await this.documents!.put(policyKey, serializeOutboundHttpPolicy(policy))
		} catch (cause) {
			this.writeFault = new Error(
				'[core.http] policy commit was not confirmed; inspect outbound-http/' + policyKey,
				{ cause },
			)
			await this.releaseCandidate(
				changedDispatchers(next.dispatchers, applied.dispatchers),
				this.writeFault,
			)
		}

		this.applied = next
		const retired = changedDispatchers(applied.dispatchers, next.dispatchers)
		const cleanup = this.closeAgents(retired).then(
			(): undefined => undefined,
			() => {
				this.root.logger.warn('Outbound HTTP settings applied, but a retired proxy failed to close')
				return 'A retired outbound HTTP proxy failed to close'
			},
		)
		this.retirements.add(cleanup)
		void cleanup.then(
			() => this.retirements.delete(cleanup),
			() => this.retirements.delete(cleanup),
		)
		return { snapshot: this.describe(next, owner), cleanup }
	}

	private async releaseCandidate(
		agents: readonly ProxyResource[],
		failure: unknown,
	): Promise<never> {
		try {
			await this.closeAgents(agents)
		} catch (cleanup) {
			throw new AggregateError(
				[failure, cleanup],
				'[core.http] policy and candidate cleanup failed',
				{ cause: cleanup },
			)
		}
		throw failure
	}

	private async closeAgents(agents: readonly ProxyResource[]): Promise<void> {
		const results = await Promise.allSettled(
			agents.map(async (agent) => {
				// An injected Fetch may defer dispatch until after a new policy is published.
				if (agent.active > 0) {
					await new Promise<void>((resolve) => {
						agent.notifyIdle = resolve
					})
				}
				await agent.dispatcher.close()
				this.resources.delete(agent)
			}),
		)
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (failures.length > 0) throw new AggregateError(failures, '[core.http] proxy close failed')
	}

	private async dispose(): Promise<void> {
		this.shutdown.abort(new DOMException('Outbound HTTP Host closed', 'AbortError'))
		await this.writeTail
		await this.restored?.catch((): void => undefined)
		const results = await Promise.allSettled(
			[...this.resources].map((agent) => agent.dispatcher.destroy()),
		)
		await Promise.allSettled(this.retirements)
		this.resources.clear()
		this.activity?.clear()
		this.logs?.reset()
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (failures.length > 0) throw new AggregateError(failures, '[core.http] proxy shutdown failed')
	}

	private async send(
		caller: Caller,
		input: Parameters<OutboundFetch>[0],
		init: NodeRequestInit | undefined,
		lifetime: AbortSignal,
	): Promise<Response> {
		if (typeof input === 'string') input = new URL(input)
		const original = input instanceof Request ? input : undefined
		const redirect = init?.redirect ?? original?.redirect
		// workerd supports manual and follow. Apply the error contract below the transport.
		const request = new Request(
			input,
			init?.redirect === 'error' ? requestInitWith(init, 'redirect', 'manual') : init,
		)
		const url = new URL(request.url)
		if (url.protocol !== 'http:' && url.protocol !== 'https:')
			throw new TypeError('[core.http] requests require an absolute HTTP(S) URL')
		const signal =
			original || init !== undefined ? AbortSignal.any([lifetime, request.signal]) : lifetime
		const startedAt = this.logs ? performance.now() : undefined
		const { key } = caller
		try {
			const initiallyApplied = this.applied ?? (await this.current(signal))
			const initial = initiallyApplied.nodes.get(key) ?? initiallyApplied.host
			signal.throwIfAborted()
			enforce(initial.origins, url.origin, redirect, init?.dispatcher)
			const slot = this.admission.acquire(signal)
			const release = typeof slot === 'function' ? slot : await slot
			try {
				signal.throwIfAborted()
				const applied = this.applied!
				const policy =
					applied === initiallyApplied ? initial : (applied.nodes.get(key) ?? applied.host)
				if (policy !== initial) enforce(policy.origins, url.origin, redirect, init?.dispatcher)
				const response = await this.dispatch(
					request,
					signal,
					redirect ?? (policy.origins === undefined ? undefined : 'error'),
					policy,
					applied.dispatchers,
				)
				if (this.activity)
					this.record(
						this.activity,
						caller,
						request,
						url.origin,
						startedAt,
						'response',
						response.status || undefined,
					)
				return response
			} finally {
				release()
			}
		} catch (error) {
			const denied = error instanceof OutboundHttpError
			const code = denied
				? error.code
				: signal.aborted
					? 'aborted'
					: error instanceof DOMException && error.name === 'TimeoutError'
						? 'timeout'
						: undefined
			if (this.activity)
				this.record(
					this.activity,
					caller,
					request,
					url.origin,
					startedAt,
					denied ? 'denied' : 'failed',
					undefined,
					code,
				)
			throw error
		}
	}

	private async dispatch(
		request: Request,
		lifetime: AbortSignal,
		redirect: RequestInit['redirect'],
		{ effective: settings, defaultHeaders }: Applied['host'],
		dispatchers: Dispatchers,
	): Promise<Response> {
		let headers: Headers | undefined
		for (const [name, value] of defaultHeaders) {
			if (!request.headers.has(name)) (headers ??= new Headers(request.headers)).set(name, value)
		}
		const deadline = settings.timeoutMs > 0 ? new AbortController() : undefined
		const signal = deadline ? AbortSignal.any([lifetime, deadline.signal]) : lifetime
		const proxy = settings.proxyUrl === null ? undefined : dispatchers.get(settings.proxyUrl)
		const timeout = deadline
			? setTimeout(
					() => deadline.abort(new DOMException('Outbound HTTP attempt timed out', 'TimeoutError')),
					settings.timeoutMs,
				)
			: undefined
		if (proxy) proxy.active++
		try {
			const requestInit: RequestInit = {
				signal,
				...(headers === undefined ? {} : { headers }),
				...(redirect === undefined ? {} : { redirect: redirect === 'error' ? 'manual' : redirect }),
			}
			const dispatcher: NodeRequestInit | undefined = proxy && { dispatcher: proxy.dispatcher }
			const fetch = this.options.fetch
			const response = await (fetch
				? fetch(new Request(request, requestInit), dispatcher)
				: globalThis.fetch(request, dispatcher ? { ...requestInit, ...dispatcher } : requestInit))
			if (redirect === 'error') {
				// A browser's manual redirect can be opaque with status zero.
				const responseType: string = response.type
				if (responseType === 'opaqueredirect' || redirectStatuses.has(response.status)) {
					void response.body?.cancel().catch(() => {})
					throw new TypeError('Outbound HTTP request encountered a redirect in error mode')
				}
			}
			return response
		} finally {
			if (proxy) {
				proxy.active--
				if (proxy.active === 0) proxy.notifyIdle?.()
			}
			if (timeout !== undefined) clearTimeout(timeout)
		}
	}

	private record(
		activity: Map<string, OutboundHttpActivity>,
		{ address, key, log }: Caller,
		request: Request,
		origin: string,
		startedAt: number | undefined,
		outcome: OutboundHttpActivity['lastOutcome'],
		status?: number,
		code?: string,
	): void {
		const previous = activity.get(key)
		const now = Date.now()
		activity.set(
			key,
			Object.freeze({
				owner: address,
				lastAttemptAt: now,
				lastOrigin: origin,
				received: (previous?.received ?? 0) + Number(outcome === 'response'),
				failed: (previous?.failed ?? 0) + Number(outcome === 'failed'),
				denied: (previous?.denied ?? 0) + Number(outcome === 'denied'),
				lastOutcome: outcome,
				...(status === undefined ? {} : { lastStatus: status }),
				...(code === undefined ? {} : { lastCode: code }),
			}),
		)
		if (startedAt === undefined || !log || !this.logs) return
		const method = request.method.slice(0, 64)
		const logOrigin = origin.slice(0, 512)
		const durationMs = Math.round(performance.now() - startedAt)
		const result = status === undefined ? (code ?? outcome) : String(status)
		const props = {
			outcome,
			method,
			origin: logOrigin,
			durationMs,
			...(status === undefined ? {} : { status }),
			...(code === undefined ? {} : { code }),
		}
		this.logs.append([
			{
				ts: now,
				level: outcome === 'response' ? 'info' : 'warning',
				category: ['pluxel', 'outbound-http'],
				plugin: address,
				...log,
				msg: `${method} ${logOrigin} · ${result} · ${durationMs} ms`,
				props,
			},
		])
	}
}

function bindOwnerFetch(
	owner: Context,
	send: (
		input: Parameters<OutboundFetch>[0],
		init: NodeRequestInit | undefined,
		lifetime: AbortSignal,
	) => Promise<Response>,
	shutdown?: AbortSignal,
): OutboundFetch {
	let lifetime: AbortSignal | undefined
	return async (input, init) => {
		const root = enterOwnerInvocation(owner.root)
		try {
			const lease = enterOwnerInvocation(owner)
			try {
				lifetime ??= AbortSignal.any(
					shutdown ? [root.signal, lease.signal, shutdown] : [root.signal, lease.signal],
				)
				lifetime.throwIfAborted()
				return await send(input, init, lifetime)
			} finally {
				lease.dispose()
			}
		} finally {
			root.dispose()
		}
	}
}

function nextPolicyRevision(policy: OutboundHttpPolicy): number {
	const revision = policy.revision + 1
	if (!Number.isSafeInteger(revision))
		throw new RangeError('[core.http] policy revision limit reached')
	return revision
}

function bindUnmanagedFetch(owner: Context, transport?: OutboundFetch): OutboundFetch {
	let defaults: RequestInit | undefined
	const send = transport ?? ((input, init) => globalThis.fetch(input, init))
	return bindOwnerFetch(owner, (input, init, lifetime) => {
		if (!transport && init === undefined && !(input instanceof Request))
			return send(input, (defaults ??= Object.freeze({ signal: lifetime })))
		const caller =
			init?.signal === undefined && input instanceof Request ? input.signal : init?.signal
		const signal = caller ? AbortSignal.any([lifetime, caller]) : lifetime
		return send(input, requestInitWith(init, 'signal', signal))
	})
}

function requestInitWith<K extends 'signal' | 'redirect'>(
	init: RequestInit | undefined,
	key: K,
	value: RequestInit[K],
): RequestInit {
	const override = { [key]: value }
	if (!init) return override
	const prototype: unknown = Object.getPrototypeOf(init)
	if (prototype === Object.prototype || prototype === null) return { ...init, ...override }
	// Fetch accepts a Request as the options dictionary. Its inherited getters require the original receiver.
	return new Proxy(override, {
		get(_target, property) {
			return property === key ? value : Reflect.get(init, property, init)
		},
	})
}

async function waitForPolicy(policy: Promise<Applied>, signal: AbortSignal): Promise<Applied> {
	let abort!: () => void
	const aborted = new Promise<never>((_, reject) => {
		abort = () => reject(signal.reason)
		signal.addEventListener('abort', abort, { once: true })
	})
	try {
		return await Promise.race([policy, aborted])
	} finally {
		signal.removeEventListener('abort', abort)
	}
}

function changedDispatchers(previous: Dispatchers, next: Dispatchers): ProxyResource[] {
	return [...previous].flatMap(([url, dispatcher]) =>
		next.get(url) === dispatcher ? [] : [dispatcher],
	)
}

function enforce(
	origins: ReadonlySet<string> | undefined,
	origin: string,
	redirect: RequestInit['redirect'],
	dispatcher: Dispatcher | undefined,
): void {
	if (origins !== undefined && !origins.has(origin))
		throw new OutboundHttpError('origin_denied', 'Outbound HTTP origin is not allowed: ' + origin)
	if (origins !== undefined && redirect === 'follow')
		throw new OutboundHttpError(
			'redirect_denied',
			'Restricted outbound HTTP requires redirect: error or manual',
		)
	if (dispatcher !== undefined)
		throw new OutboundHttpError(
			'dispatcher_conflict',
			'The Host owns Dispatcher selection for managed outbound HTTP',
		)
}
