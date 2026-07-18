import { BasePlugin, Plugin, type Context, type PersistenceNamespace } from '@pluxel/runtime'
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

@Plugin({ name: 'WretchPlugin' })
export class WretchPlugin extends BasePlugin {
	private readonly config = this.configs.use(WretchConfig)
	private readonly managed = new WeakMap<Context, ManagedSettingsState>()
	private policy?: OutboundPolicy
	private storage?: PersistenceNamespace

	override init(): void {
		this.policy = createOutboundPolicy(this.config)
		this.storage = this.ctx.root.persistence.namespace(SETTINGS_NAMESPACE)
		this.ctx.workbench.mount(WretchWorkbench, {})
	}

	/**
	 * A native immutable Wretch base. Caller-managed settings are resolved immediately before every
	 * request, so cached clients observe settings enabled or changed after their creation.
	 */
	get client(): Wretch {
		const policy = this.requirePolicy()
		const owner = this.ctx.caller
		return wretch().defer((client, _url, options) => {
			const state = owner ? this.managed.get(owner) : undefined
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
				policy.middleware(() => this.effectiveTimeout(state?.current.timeoutMs)),
			])
		})
	}

	/** Enables persisted settings for clients obtained through this caller-bound dependency. */
	async enableManagedSettings(): Promise<void> {
		const owner = this.requireCaller()
		if (this.managed.has(owner)) return
		const state = await loadManagedSettings(this.requireStorage(), this.settingsKey(owner))
		this.managed.set(owner, state)
		owner.effects.defer(async () => {
			if (this.managed.get(owner) === state) this.managed.delete(owner)
			await disposeManagedSettings(state)
		})
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
		return new ManagedSettingsRpc(
			() => this.snapshot(state),
			(settings) => replaceManagedSettings(state, storage, key, settings, this.config.timeoutMs),
			() => resetManagedSettings(state, storage, key),
		)
	}

	private effectiveTimeout(consumerTimeout?: number): number {
		if (!consumerTimeout) return this.config.timeoutMs
		if (this.config.timeoutMs <= 0) return consumerTimeout
		return Math.min(this.config.timeoutMs, consumerTimeout)
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
		return `consumers/${encodeURIComponent(owner.pluginInfo.id)}.json`
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
