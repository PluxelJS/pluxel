import { createHash } from 'node:crypto'
import {
	BasePlugin,
	encodePluginNodeAddressBytes,
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

type PluginContext = Context & { pluginInfo: NonNullable<Context['pluginInfo']> }

function stoppedClientError(): Error {
	return new Error('Wretch client belongs to a stopped or replaced plugin generation')
}

@Plugin()
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
		this.ctx.workbench?.mount(WretchWorkbench, {})
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

	/** RPC resource for a consumer-owned `WretchWorkbenchPort` outlet. */
	workbenchSettings(): RpcTarget & WretchWorkbenchCommands {
		const owner = this.requireCaller()
		const state = this.managed.get(owner)
		if (!state) {
			throw new Error('Call enableManagedSettings() before binding WretchWorkbenchPort')
		}
		const storage = this.requireStorage()
		const managed = this.managed
		const hostTimeoutMs = this.config.timeoutMs
		const key = settingsKey(owner.pluginInfo.nodeAddress)
		const assertActive = (): void => {
			if (managed.get(owner) !== state) throw stoppedClientError()
		}
		const snapshot = (): WretchManagedSettingsSnapshot => {
			assertActive()
			return Object.freeze({
				settings: state.current,
				hostTimeoutMs,
				effectiveTimeoutMs: effectiveTimeout(hostTimeoutMs, state.current.timeoutMs),
			})
		}
		return new ManagedSettingsRpc(
			snapshot,
			async (settings) => {
				assertActive()
				const current = await replaceManagedSettings(state, storage, key, settings, hostTimeoutMs)
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
		const state = await loadManagedSettings(
			storage,
			settingsKey(owner.pluginInfo.nodeAddress),
			owner.pluginInfo.nodeAddress,
		)
		if (this.policy !== policy || this.storage !== storage) {
			await disposeManagedSettings(state)
			throw stoppedClientError()
		}
		try {
			owner.effects.defer(
				async () => {
					if (managed.get(owner) === state) managed.delete(owner)
					await disposeManagedSettings(state)
				},
				{ tag: 'wretch-managed-settings' },
			)
		} catch {
			await disposeManagedSettings(state)
			throw stoppedClientError()
		}
		managed.set(owner, state)
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

function settingsKey(owner: PluginContext['pluginInfo']['nodeAddress']): string {
	const address = parsePluginNodeAddress(owner)
	const digest = createHash('sha256').update(encodePluginNodeAddressBytes(address)).digest('hex')
	return `consumers/v3/${digest}.json`
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
