import { createHash } from 'node:crypto'
import {
	BasePlugin,
	parsePluginNodeAddress,
	Plugin,
	type Context,
	type PersistenceNamespace,
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
import type {
	WretchManagedSettings,
	WretchManagedSettingsSnapshot,
	WretchWorkbenchCommands,
} from './workbench-contract.ts'
import { WretchWorkbench } from './workbench-extension.ts'

const SETTINGS_NAMESPACE = '@pluxel/wretch'

type ClientLease = {
	active: boolean
	readonly controller: AbortController
}

function stoppedClientError(): Error {
	return new Error('Wretch client belongs to a stopped or replaced plugin generation')
}

@Plugin({ displayName: 'WretchPlugin' })
export class WretchPlugin extends BasePlugin {
	private readonly config = this.configs.use(WretchConfig)
	private readonly managed = new Map<Context, ManagedSettingsState>()
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
				await Promise.all(states.map(disposeManagedSettings))
			},
			{ tag: 'wretch-policy' },
		)
		this.ctx.workbench.mount(WretchWorkbench, {})
	}

	/**
	 * A native immutable Wretch base. Caller-managed settings are resolved immediately before every
	 * request, so cached clients observe settings enabled or changed after their creation.
	 */
	get client(): Wretch {
		const policy = this.requirePolicy()
		const owner = this.ctx.caller ?? this.ctx
		const lease = this.clientLease(owner)
		return wretch().defer((client, _url, options) => {
			const state = this.managed.get(owner)
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
					() => this.effectiveTimeout(state?.current.timeoutMs),
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

	/** RPC resource for a consumer-owned `WretchWorkbenchPort` outlet. */
	workbenchSettings(): RpcTarget & WretchWorkbenchCommands {
		const owner = this.requireCaller()
		const state = this.managed.get(owner)
		if (!state) {
			throw new Error('Call enableManagedSettings() before binding WretchWorkbenchPort')
		}
		const storage = this.requireStorage()
		const key = this.settingsKey(owner)
		const assertActive = (): void => {
			if (!this.policy || this.storage !== storage || this.managed.get(owner) !== state) {
				throw stoppedClientError()
			}
		}
		return new ManagedSettingsRpc(
			() => {
				assertActive()
				return this.snapshot(state)
			},
			async (settings) => {
				assertActive()
				const current = await replaceManagedSettings(
					state,
					storage,
					key,
					settings,
					this.config.timeoutMs,
				)
				assertActive()
				return current
			},
			async () => {
				assertActive()
				const current = await resetManagedSettings(state, storage, key)
				assertActive()
				return current
			},
		)
	}

	private effectiveTimeout(consumerTimeout?: number): number {
		if (!consumerTimeout) return this.config.timeoutMs
		if (this.config.timeoutMs <= 0) return consumerTimeout
		return Math.min(this.config.timeoutMs, consumerTimeout)
	}

	private clientLease(owner: Context): ClientLease {
		const existing = this.clients.get(owner)
		if (existing) {
			if (!existing.active) throw stoppedClientError()
			return existing
		}
		const lease: ClientLease = { active: true, controller: new AbortController() }
		this.clients.set(owner, lease)
		try {
			owner.effects.defer(
				() => {
					if (!lease.active) return
					lease.active = false
					lease.controller.abort(stoppedClientError())
					if (this.clients.get(owner) === lease) this.clients.delete(owner)
				},
				{ tag: 'wretch-client' },
			)
		} catch {
			lease.active = false
			if (this.clients.get(owner) === lease) this.clients.delete(owner)
			throw stoppedClientError()
		}
		return lease
	}

	private async initializeManagedSettings(owner: Context): Promise<ManagedSettingsState> {
		const policy = this.requirePolicy()
		const storage = this.requireStorage()
		const state = await loadManagedSettings(
			storage,
			this.settingsKey(owner),
			owner.pluginInfo.nodeAddress,
		)
		if (this.policy !== policy || this.storage !== storage) {
			await disposeManagedSettings(state)
			throw stoppedClientError()
		}
		try {
			owner.effects.defer(
				async () => {
					if (this.managed.get(owner) === state) this.managed.delete(owner)
					await disposeManagedSettings(state)
				},
				{ tag: 'wretch-managed-settings' },
			)
		} catch (error) {
			await disposeManagedSettings(state)
			throw error
		}
		this.managed.set(owner, state)
		return state
	}

	private snapshot(state: ManagedSettingsState): WretchManagedSettingsSnapshot {
		return Object.freeze({
			settings: state.current,
			hostTimeoutMs: this.config.timeoutMs,
			effectiveTimeoutMs: this.effectiveTimeout(state.current.timeoutMs),
		})
	}

	private requireCaller(): Context {
		const caller = this.ctx.caller
		if (!caller) throw new Error('Managed Wretch settings require a consumer plugin Context')
		return caller
	}

	private requirePolicy(): OutboundPolicy {
		if (!this.policy) throw new Error('WretchPlugin is not running')
		return this.policy
	}

	private requireStorage(): PersistenceNamespace {
		if (!this.storage) throw new Error('WretchPlugin is not running')
		return this.storage
	}

	private settingsKey(owner: Context): string {
		const canonicalOwner = JSON.stringify(parsePluginNodeAddress(owner.pluginInfo.nodeAddress))
		const digest = createHash('sha256').update(canonicalOwner).digest('hex')
		return `consumers/v2/${digest}.json`
	}
}

class ManagedSettingsRpc extends RpcTarget implements WretchWorkbenchCommands {
	constructor(
		private readonly read: () => WretchManagedSettingsSnapshot,
		private readonly write: (settings: WretchManagedSettings) => Promise<WretchManagedSettings>,
		private readonly clear: () => Promise<WretchManagedSettings>,
	) {
		super()
	}

	get(): WretchManagedSettingsSnapshot {
		return this.read()
	}

	async update(settings: WretchManagedSettings): Promise<WretchManagedSettingsSnapshot> {
		await this.write(settings)
		return this.read()
	}

	async reset(): Promise<WretchManagedSettingsSnapshot> {
		await this.clear()
		return this.read()
	}
}

export type { Wretch } from 'wretch'
