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
import { normalizeOutboundHttpSettings, type ResolvedOutboundHttpOptions } from './options'
import {
	compileOutboundHttpPolicy,
	parseOutboundHttpPolicy,
	serializeOutboundHttpPolicy,
	type OutboundHttpPolicy,
} from './policy'
import type {
	OutboundFetch,
	OutboundHttpActivity,
	OutboundHttpSettings,
	OutboundHttpSnapshot,
} from './types'

const policyKey = 'policy.json'
const emptySettings = Object.freeze({})
type NodeRequestInit = RequestInit & { dispatcher?: Dispatcher }
type ProxyResource = { dispatcher: Dispatcher; active: number; notifyIdle?: () => void }
type Dispatchers = ReadonlyMap<string, ProxyResource>

type Client = { fetch: OutboundFetch; wretch?: Wretch }
type Applied = ReturnType<typeof compileOutboundHttpPolicy> & { dispatchers: Dispatchers }

/** A committed settings change may still be waiting for retired connections to drain. */
export type OutboundHttpCommit = Readonly<{
	snapshot: OutboundHttpSnapshot
	cleanup: Promise<string | undefined>
}>

export class OutboundHttpRuntime {
	private readonly clients = new WeakMap<Context, Client>()
	private readonly activity = new Map<string, OutboundHttpActivity>()
	private readonly logs = new RuntimeLogStore({
		streamId: OUTBOUND_HTTP_LOG_STREAM_ID,
		windowLines: 5_000,
	})
	private readonly resources = new Set<ProxyResource>()
	private readonly retirements = new Set<Promise<string | undefined>>()
	private readonly admission: RequestAdmission
	private readonly shutdown = new AbortController()
	private restored?: Promise<Applied>
	private applied?: Applied
	private documents?: HostDocumentStorage
	private writeTail: Promise<void> = Promise.resolve()
	private writeFault?: Error
	readonly management = Object.freeze({
		logs: this.logs,
		snapshot: (owner: PluginNodeAddress | null) => this.snapshot(owner),
		save: (owner: PluginNodeAddress | null, expectedRevision: number, input: unknown) =>
			this.save(owner, expectedRevision, input),
	})

	constructor(
		private readonly root: RootContext,
		private readonly options: ResolvedOutboundHttpOptions,
	) {
		const { maxConcurrentRequests, maxQueuedRequests } = options.limits
		this.admission = new RequestAdmission(maxConcurrentRequests, maxQueuedRequests)
		root.effects.defer(() => this.dispose(), { tag: 'OutboundHTTP', phase: 'shutdown' })
	}

	fetchFor(owner: Context): OutboundFetch {
		if (owner.root !== this.root)
			throw new TypeError('[core.http] the owner belongs to another Host')
		const existing = this.clients.get(owner)
		if (existing) return existing.fetch
		const address = owner.pluginInfo?.nodeAddress
		if (!address) throw new TypeError('[core.http] a Plugin node address is required')
		const key = pluginNodeIndexKey(address)
		const fetch: OutboundFetch = (input, init) =>
			this.fetchAttempt(owner, address, key, input, init)
		this.clients.set(owner, { fetch })
		return fetch
	}

	wretchFor(owner: Context): Wretch {
		const fetch = this.fetchFor(owner)
		const client = this.clients.get(owner)!
		return (client.wretch ??= wretch().fetchPolyfill(fetch))
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
			this.activity.delete(key)
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

	private describe(applied: Applied, owner: PluginNodeAddress | null): OutboundHttpSnapshot {
		const { policy, host, nodes } = applied
		const key = owner === null ? undefined : pluginNodeIndexKey(owner)
		const seen = key === undefined ? undefined : this.activity.get(key)
		return Object.freeze({
			revision: policy.revision,
			owner,
			settings:
				key === undefined ? policy.defaults : (policy.nodes.get(key)?.settings ?? emptySettings),
			effective: (key === undefined ? host : (nodes.get(key) ?? host)).effective,
			limits: this.options.limits,
			activity: Object.freeze(
				key === undefined
					? [...this.activity.values()].sort((a, b) => comparePluginNodeAddress(a.owner, b.owner))
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
		const revision = applied.policy.revision + 1
		if (!Number.isSafeInteger(revision))
			throw new RangeError('[core.http] policy revision limit reached')
		const policy: OutboundHttpPolicy = {
			revision,
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
		this.activity.clear()
		this.logs.reset()
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (failures.length > 0) throw new AggregateError(failures, '[core.http] proxy shutdown failed')
	}

	private async fetchAttempt(
		owner: Context,
		address: PluginNodeAddress,
		key: string,
		input: RequestInfo | URL,
		init?: NodeRequestInit,
	): Promise<Response> {
		this.shutdown.signal.throwIfAborted()
		const rootLease = enterOwnerInvocation(this.root)
		try {
			const lease = enterOwnerInvocation(owner)
			try {
				return await this.send(owner, address, key, input, init, [
					rootLease.signal,
					lease.signal,
					this.shutdown.signal,
				])
			} finally {
				lease.dispose()
			}
		} finally {
			rootLease.dispose()
		}
	}

	private async send(
		owner: Context,
		address: PluginNodeAddress,
		key: string,
		input: RequestInfo | URL,
		init: NodeRequestInit | undefined,
		lifetimes: AbortSignal[],
	): Promise<Response> {
		if (typeof input === 'string') input = new URL(input)
		const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined)
		const request = new Request(input, init)
		const url = new URL(request.url)
		if (url.protocol !== 'http:' && url.protocol !== 'https:')
			throw new TypeError('[core.http] requests require an absolute HTTP(S) URL')
		const signal = AbortSignal.any([...lifetimes, request.signal])
		const startedAt = performance.now()
		try {
			const initiallyApplied = await this.current(signal)
			signal.throwIfAborted()
			enforce(
				(initiallyApplied.nodes.get(key) ?? initiallyApplied.host).origins,
				url.origin,
				redirect,
				init?.dispatcher,
			)
			const release = await this.admission.acquire(signal)
			try {
				signal.throwIfAborted()
				const applied = this.applied!
				const { origins, effective } = applied.nodes.get(key) ?? applied.host
				enforce(origins, url.origin, redirect, init?.dispatcher)
				const response = await this.dispatch(
					request,
					signal,
					origins === undefined ? undefined : (redirect ?? 'error'),
					effective,
					applied.dispatchers,
				)
				this.record(
					owner,
					address,
					key,
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
			this.record(
				owner,
				address,
				key,
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
		redirect: RequestRedirect | undefined,
		settings: Applied['host']['effective'],
		dispatchers: Dispatchers,
	): Promise<Response> {
		const headers = new Headers(request.headers)
		for (const [name, value] of Object.entries(settings.headers)) {
			if (!headers.has(name)) headers.set(name, value)
		}
		const deadline = new AbortController()
		const signal = AbortSignal.any([lifetime, deadline.signal])
		const proxy = settings.proxyUrl === null ? undefined : dispatchers.get(settings.proxyUrl)
		const timeout =
			settings.timeoutMs > 0
				? setTimeout(
						() =>
							deadline.abort(new DOMException('Outbound HTTP attempt timed out', 'TimeoutError')),
						settings.timeoutMs,
					)
				: undefined
		if (proxy) proxy.active++
		try {
			const outgoing = new Request(request, {
				headers,
				signal,
				...(redirect === undefined ? {} : { redirect }),
			})
			const init: NodeRequestInit | undefined = proxy && { dispatcher: proxy.dispatcher }
			const fetch = this.options.fetch
			return await (fetch ? fetch(outgoing, init) : globalThis.fetch(outgoing, init))
		} finally {
			if (proxy) {
				proxy.active--
				if (proxy.active === 0) proxy.notifyIdle?.()
			}
			if (timeout !== undefined) clearTimeout(timeout)
		}
	}

	private record(
		owner: Context,
		address: PluginNodeAddress,
		key: string,
		request: Request,
		origin: string,
		startedAt: number,
		outcome: OutboundHttpActivity['lastOutcome'],
		status?: number,
		code?: string,
	): void {
		const previous = this.activity.get(key)
		const now = Date.now()
		this.activity.set(
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
		const method = request.method.slice(0, 64)
		const logOrigin = origin.slice(0, 512)
		const durationMs = Math.round(performance.now() - startedAt)
		const pluginReference = formatPluginNodeReference(address)
		const name = owner.pluginInfo?.displayName ?? address.definition.exportName
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
				pluginReference,
				name: address.variant === 'fork' ? `${name} · ${address.forkId}` : name,
				msg: `${method} ${logOrigin} · ${result} · ${durationMs} ms`,
				props,
			},
		])
	}
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

async function createProxyDispatcher(url: string): Promise<Dispatcher> {
	// Only reached for a Node Host with a configured proxy. Keep Undici out of browser bundles.
	const moduleName: string = 'undici'
	const { ProxyAgent, Dispatcher1Wrapper } = (await import(
		/* @vite-ignore */ moduleName
	)) as typeof import('undici')
	const agent = new ProxyAgent(url)
	// Node 24's built-in Fetch still uses the legacy Dispatcher handler protocol.
	return Number.parseInt(process.versions.undici ?? '0', 10) < 8
		? new Dispatcher1Wrapper(agent)
		: agent
}

function enforce(
	origins: ReadonlySet<string> | undefined,
	origin: string,
	redirect: RequestRedirect | undefined,
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
