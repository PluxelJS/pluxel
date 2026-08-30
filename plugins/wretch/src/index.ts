import { createHash } from 'node:crypto'
import {
	BasePlugin,
	encodePluginNodeAddressBytes,
	parsePluginNodeAddress,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	Plugin,
	type Context,
	type PersistenceNamespace,
	type PluginNodeAddress,
} from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import wretch, { type Wretch } from 'wretch'
import { WretchConfig } from './config.ts'
import {
	disposeManagedSettings,
	loadManagedSettings,
	replaceManagedSettings,
	resetManagedSettings,
	type ManagedSettingsState,
} from './managed-settings.ts'
import { createOutboundPolicy, type OutboundPolicy } from './outbound-policy.ts'
import {
	WretchWorkbench,
	type WretchManagedSettings,
	type WretchManagedSettingsSnapshot,
	type WretchSettingsApi,
} from './workbench.ts'

const SETTINGS_NAMESPACE = '@pluxel/wretch'

type ClientLease = {
	active: boolean
	readonly controller: AbortController
}

type PluginContext = Context & { pluginInfo: NonNullable<Context['pluginInfo']> }

function stoppedClientError(): Error {
	return new Error('Wretch client belongs to a stopped or replaced plugin generation')
}

@Plugin()
export class WretchPlugin extends BasePlugin {
	private readonly config = this.configs.use(WretchConfig)
	private readonly managed = new Map<Context, ManagedSettingsState>()
	private readonly managedByNode = new Map<string, ManagedSettingsState>()
	private readonly managedInitializations = new WeakMap<Context, Promise<ManagedSettingsState>>()
	private readonly clients = new WeakMap<Context, ClientLease>()
	private policy?: OutboundPolicy
	private storage?: PersistenceNamespace

	override init(): void {
		const policy = createOutboundPolicy(this.config)
		const storage = this.ctx.root.persistence.namespace(SETTINGS_NAMESPACE)
		this.policy = policy
		this.storage = storage
		this.ctx.effects.defer(
			async () => {
				policy.dispose()
				if (this.policy === policy) this.policy = undefined
				if (this.storage === storage) this.storage = undefined
				const states = [...this.managed.values()]
				this.managed.clear()
				this.managedByNode.clear()
				await Promise.all(states.map(disposeManagedSettings))
			},
			{ tag: 'wretch-policy' },
		)
		this.ctx.workbench?.publish(WretchWorkbench, {
			settings: ({ consumer, signal }) =>
				createSettingsTarget(
					this.managedByNode,
					this.requireStorage(),
					this.config.timeoutMs,
					consumer.node,
					signal,
				),
		})
	}

	/**
	 * A native immutable Wretch base. Caller-managed settings are resolved immediately before every
	 * request, so cached clients observe settings enabled or changed after their creation.
	 */
	get client(): Wretch {
		const policy = this.requirePolicy()
		const owner = this.ctx.caller ?? this.ctx
		const lease = this.clientLease(owner)
		const managed = this.managed
		const hostTimeoutMs = this.config.timeoutMs
		return wretch().defer((client, _url, options) => {
			const state = managed.get(owner)
			let configured = client
			if (state) {
				const headers = new Headers(options.headers)
				for (const [name, value] of Object.entries(state.current.headers)) {
					headers.set(name, value)
				}
				configured = configured.options(
					{
						...options,
						headers,
						...(state.dispatcher ? { dispatcher: state.dispatcher } : {}),
					},
					true,
				)
			}
			return configured.middlewares([
				policy.middleware(
					() => effectiveTimeout(hostTimeoutMs, state?.current.timeoutMs),
					lease.controller.signal,
				),
			])
		})
	}

	/** Enables persisted settings for clients obtained through this caller-bound dependency. */
	async enableManagedSettings(): Promise<void> {
		const owner = this.requireCaller()
		if (this.managed.has(owner)) return
		let initialization = this.managedInitializations.get(owner)
		if (!initialization) {
			initialization = this.initializeManagedSettings(owner)
			this.managedInitializations.set(owner, initialization)
		}
		try {
			await initialization
		} finally {
			if (this.managedInitializations.get(owner) === initialization) {
				this.managedInitializations.delete(owner)
			}
		}
	}

	private clientLease(owner: Context): ClientLease {
		const clients = this.clients
		const existing = clients.get(owner)
		if (existing) {
			if (!existing.active) throw stoppedClientError()
			return existing
		}
		const lease: ClientLease = { active: true, controller: new AbortController() }
		clients.set(owner, lease)
		try {
			owner.effects.defer(
				() => {
					if (!lease.active) return
					lease.controller.abort(stoppedClientError())
					if (clients.get(owner) === lease) clients.delete(owner)
				},
				{ tag: 'wretch-client' },
			)
		} catch {
			lease.active = false
			if (clients.get(owner) === lease) clients.delete(owner)
			throw stoppedClientError()
		}
		return lease
	}

	private async initializeManagedSettings(owner: PluginContext): Promise<ManagedSettingsState> {
		const policy = this.requirePolicy()
		const storage = this.requireStorage()
		const managed = this.managed
		const managedByNode = this.managedByNode
		const nodeKey = pluginNodeIndexKey(owner.pluginInfo.nodeAddress)
		const state = await loadManagedSettings(
			storage,
			settingsKey(owner.pluginInfo.nodeAddress),
			owner.pluginInfo.nodeAddress,
		)
		if (this.policy !== policy || this.storage !== storage) {
			await disposeManagedSettings(state)
			throw stoppedClientError()
		}
		if (managedByNode.has(nodeKey)) {
			await disposeManagedSettings(state)
			throw new Error('Managed Wretch settings already exist for this Plugin node')
		}
		try {
			owner.effects.defer(
				async () => {
					if (managed.get(owner) === state) managed.delete(owner)
					if (managedByNode.get(nodeKey) === state) managedByNode.delete(nodeKey)
					await disposeManagedSettings(state)
				},
				{ tag: 'wretch-managed-settings' },
			)
		} catch {
			await disposeManagedSettings(state)
			throw stoppedClientError()
		}
		managed.set(owner, state)
		managedByNode.set(nodeKey, state)
		return state
	}

	private requireCaller(): PluginContext {
		const caller = this.ctx.caller
		if (!caller) throw new Error('Managed Wretch settings require a consumer plugin Context')
		if (!caller.pluginInfo) throw new Error('Managed Wretch settings require a Plugin owner')
		return caller as PluginContext
	}

	private requirePolicy(): OutboundPolicy {
		if (!this.policy) throw new Error('WretchPlugin is not running')
		return this.policy
	}

	private requireStorage(): PersistenceNamespace {
		if (!this.storage) throw new Error('WretchPlugin is not running')
		return this.storage
	}
}

function effectiveTimeout(hostTimeoutMs: number, consumerTimeout?: number): number {
	if (!consumerTimeout) return hostTimeoutMs
	if (hostTimeoutMs <= 0) return consumerTimeout
	return Math.min(hostTimeoutMs, consumerTimeout)
}

function settingsKey(owner: PluginNodeAddress): string {
	const address = parsePluginNodeAddress(owner)
	const digest = createHash('sha256').update(encodePluginNodeAddressBytes(address)).digest('hex')
	return `consumers/v3/${digest}.json`
}

function createSettingsTarget(
	managed: ReadonlyMap<string, ManagedSettingsState>,
	storage: PersistenceNamespace,
	hostTimeoutMs: number,
	consumerNode: PluginNodeAddress,
	signal: AbortSignal,
): WretchSettingsApi {
	const owner = parsePluginNodeAddress(consumerNode)
	const nodeKey = pluginNodeIndexKey(owner)
	const state = managed.get(nodeKey)
	if (!state || !pluginNodeAddressEqual(state.owner, owner)) {
		throw new Error('Call enableManagedSettings() before opening Wretch settings')
	}
	return new WretchSettingsTarget(
		managed,
		nodeKey,
		state,
		storage,
		settingsKey(owner),
		hostTimeoutMs,
		signal,
	)
}

class WretchSettingsTarget extends RpcTarget implements WretchSettingsApi {
	readonly #managed: ReadonlyMap<string, ManagedSettingsState>
	readonly #nodeKey: string
	readonly #state: ManagedSettingsState
	readonly #storage: PersistenceNamespace
	readonly #key: string
	readonly #hostTimeoutMs: number
	readonly #signal: AbortSignal

	constructor(
		managed: ReadonlyMap<string, ManagedSettingsState>,
		nodeKey: string,
		state: ManagedSettingsState,
		storage: PersistenceNamespace,
		key: string,
		hostTimeoutMs: number,
		signal: AbortSignal,
	) {
		super()
		this.#managed = managed
		this.#nodeKey = nodeKey
		this.#state = state
		this.#storage = storage
		this.#key = key
		this.#hostTimeoutMs = hostTimeoutMs
		this.#signal = signal
	}

	snapshot(): WretchManagedSettingsSnapshot {
		this.#assertActive()
		return Object.freeze({
			settings: this.#state.current,
			hostTimeoutMs: this.#hostTimeoutMs,
			effectiveTimeoutMs: effectiveTimeout(this.#hostTimeoutMs, this.#state.current.timeoutMs),
		})
	}

	async update(settings: WretchManagedSettings): Promise<WretchManagedSettingsSnapshot> {
		this.#assertActive()
		await replaceManagedSettings(
			this.#state,
			this.#storage,
			this.#key,
			settings,
			this.#hostTimeoutMs,
		)
		return this.snapshot()
	}

	async reset(): Promise<WretchManagedSettingsSnapshot> {
		this.#assertActive()
		await resetManagedSettings(this.#state, this.#storage, this.#key)
		return this.snapshot()
	}

	#assertActive(): void {
		if (this.#managed.get(this.#nodeKey) !== this.#state || this.#signal.aborted) {
			throw stoppedClientError()
		}
	}
}

export type { Wretch } from 'wretch'
