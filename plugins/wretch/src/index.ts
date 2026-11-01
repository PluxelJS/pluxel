import { assertWorkbenchDto } from '@pluxel/workbench/server'
import {
	parsePluginNodeAddress,
	type TinyBaseService,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
	BasePlugin,
	Plugin,
} from '@pluxel/core'

import { RpcTarget } from 'capnweb'
import wretch, { type Wretch } from 'wretch'
import { WretchConfig } from './config.ts'
import { ManagedSettingsStore, type ManagedSettingsState } from './managed-settings.ts'
import { createOutboundPolicy, type OutboundPolicy } from './outbound-policy.ts'
import {
	WretchWorkbench,
	type WretchManagedSettings,
	type WretchManagedSettingsSnapshot,
	type WretchSettingsApi,
} from './workbench.ts'

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
	private readonly storageState: {
		service?: TinyBaseService
		prepared?: Promise<ManagedSettingsStore>
		store?: ManagedSettingsStore
	} = {}

	override init(): void {
		const policy = createOutboundPolicy(this.config)
		this.policy = policy
		this.storageState.service = this.ctx.tinybase
		this.ctx.effects.defer(
			async () => {
				policy.dispose()
				if (this.policy === policy) {
					this.policy = undefined
					this.storageState.service = undefined
				}
				const states = [...this.managed.values()]
				this.managed.clear()
				this.managedByNode.clear()
				await Promise.all(states.map((state) => this.storageState.store?.dispose(state)))
			},
			{ tag: 'wretch-policy' },
		)
		this.ctx.workbench?.publish(WretchWorkbench, {
			settings: async ({ consumer, signal }) =>
				createSettingsTarget(
					this.managedByNode,
					await this.requireStorage(),
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

	/** Persisted, non-secret settings for the enabled caller; independent of Workbench. */
	get managedSettings(): WretchManagedSettingsSnapshot {
		return settingsSnapshot(this.requireManagedSettings(), this.config.timeoutMs)
	}

	/** Replaces the caller's saved settings. Host origin, capacity and timeout limits still apply. */
	async updateManagedSettings(
		settings: WretchManagedSettings,
	): Promise<WretchManagedSettingsSnapshot> {
		const state = this.requireManagedSettings()
		const storage = await this.requireStorage()
		await storage.replace(state, settings, this.config.timeoutMs)
		return this.managedSettings
	}

	/** Deletes the caller's saved settings and restores its native client options. */
	async resetManagedSettings(): Promise<WretchManagedSettingsSnapshot> {
		const state = this.requireManagedSettings()
		const storage = await this.requireStorage()
		await storage.reset(state)
		return this.managedSettings
	}

	private requireManagedSettings(): ManagedSettingsState {
		this.requirePolicy()
		const state = this.managed.get(this.requireCaller())
		if (!state)
			throw new Error('Call enableManagedSettings() before accessing managed Wretch settings')
		return state
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

	private initializeManagedSettings(owner: PluginContext): Promise<ManagedSettingsState> {
		const policy = this.requirePolicy()
		const managed = this.managed
		const managedByNode = this.managedByNode
		const nodeKey = pluginNodeIndexKey(owner.pluginInfo.nodeAddress)
		let initialization: Promise<ManagedSettingsState> | undefined
		// Own the pending read before I/O so shutdown also drains admitted initialization.
		let cleanup
		try {
			cleanup = owner.effects.defer(
				async () => {
					const state = await initialization?.catch((): undefined => undefined)
					if (!state) return
					if (managed.get(owner) === state) managed.delete(owner)
					if (managedByNode.get(nodeKey) === state) managedByNode.delete(nodeKey)
					await this.storageState.store?.dispose(state)
				},
				{ tag: 'wretch-managed-settings' },
			)
		} catch {
			throw stoppedClientError()
		}
		initialization = (async () => {
			const storage = await this.requireStorage()
			const state = await storage.load(owner.pluginInfo.nodeAddress)
			if (this.policy !== policy || this.storageState.store !== storage) {
				await this.storageState.store?.dispose(state)
				throw stoppedClientError()
			}
			if (managedByNode.has(nodeKey)) {
				await this.storageState.store?.dispose(state)
				throw new Error('Managed Wretch settings already exist for this Plugin node')
			}
			managed.set(owner, state)
			managedByNode.set(nodeKey, state)
			return state
		})()
		return initialization.catch((error) => {
			cleanup.cancel()
			throw error
		})
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

	private async requireStorage(): Promise<ManagedSettingsStore> {
		const policy = this.requirePolicy()
		if (!this.storageState.prepared) {
			const service = this.storageState.service
			if (!service) throw stoppedClientError()
			this.storageState.prepared = service.open().then((store) => {
				if (this.policy !== policy) throw stoppedClientError()
				const managed = new ManagedSettingsStore(store, () => service.flush())
				this.storageState.store = managed
				return managed
			})
		}
		return this.storageState.prepared
	}
}

function effectiveTimeout(hostTimeoutMs: number, consumerTimeout?: number): number {
	if (!consumerTimeout) return hostTimeoutMs
	if (hostTimeoutMs <= 0) return consumerTimeout
	return Math.min(hostTimeoutMs, consumerTimeout)
}

function settingsSnapshot(
	state: ManagedSettingsState,
	hostTimeoutMs: number,
): WretchManagedSettingsSnapshot {
	return Object.freeze({
		settings: state.current,
		hostTimeoutMs,
		effectiveTimeoutMs: effectiveTimeout(hostTimeoutMs, state.current.timeoutMs),
	})
}

function createSettingsTarget(
	managed: ReadonlyMap<string, ManagedSettingsState>,
	storage: ManagedSettingsStore,
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
	return new WretchSettingsTarget(managed, nodeKey, state, storage, hostTimeoutMs, signal)
}

class WretchSettingsTarget extends RpcTarget implements WretchSettingsApi {
	readonly #managed: ReadonlyMap<string, ManagedSettingsState>
	readonly #nodeKey: string
	readonly #state: ManagedSettingsState
	readonly #storage: ManagedSettingsStore
	readonly #hostTimeoutMs: number
	readonly #signal: AbortSignal

	constructor(
		managed: ReadonlyMap<string, ManagedSettingsState>,
		nodeKey: string,
		state: ManagedSettingsState,
		storage: ManagedSettingsStore,
		hostTimeoutMs: number,
		signal: AbortSignal,
	) {
		super()
		this.#managed = managed
		this.#nodeKey = nodeKey
		this.#state = state
		this.#storage = storage
		this.#hostTimeoutMs = hostTimeoutMs
		this.#signal = signal
	}

	snapshotDto(): WretchManagedSettingsSnapshot {
		this.#assertActive()
		const snapshot = settingsSnapshot(this.#state, this.#hostTimeoutMs)
		assertWorkbenchDto(snapshot)
		return snapshot
	}

	async updateDto(settings: WretchManagedSettings): Promise<WretchManagedSettingsSnapshot> {
		this.#assertActive()
		await this.#storage.replace(this.#state, settings, this.#hostTimeoutMs)
		return this.snapshotDto()
	}

	async resetDto(): Promise<WretchManagedSettingsSnapshot> {
		this.#assertActive()
		await this.#storage.reset(this.#state)
		return this.snapshotDto()
	}

	#assertActive(): void {
		if (this.#managed.get(this.#nodeKey) !== this.#state || this.#signal.aborted) {
			throw stoppedClientError()
		}
	}
}

export type { Wretch } from 'wretch'
export { WretchConfig } from './config.ts'
export type { WretchPluginConfig } from './config.ts'
export type { WretchManagedSettings, WretchManagedSettingsSnapshot } from './workbench-contracts.ts'

export { WretchSettingsCleanupError } from './managed-settings.ts'
