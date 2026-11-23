import type { VaultServiceConfig, VaultStorageApi } from '../vault/types'
import type { FsConfig, FsPromises, FsRequirement } from '../fs/service'
import type { TinyBaseOptions, TinyBaseService } from '../tinybase/types'
import type { Context as BaseContext, RootContext as BaseRootContext } from '@pluxel/context'
import type { ContextLogger } from '../logger/LoggerService'
import type { EffectsScope } from '../services/effects/EffectsService'
import type { RuntimeLogging } from '../logging/logging'
import type { LogTapeConfig } from '../logging/config'
import type { PluginNodeInfo } from '../plugins/runtime/PluginDefinitions'
import type { CoreExecutionConfig } from './plugin-execution'
import type { EventsService, EventsServiceConfig } from '../services/events/EventsService'
import type { Wretch } from 'wretch'
import type { OutboundFetch, OutboundHttpOptions } from '../http/types'

/** Plugin-facing Context. Service installation and construction remain Host-owned. */
export interface Context extends BaseContext<RootContext> {
	readonly parent?: Context
	readonly logger: ContextLogger
	readonly effects: EffectsScope
	readonly events: EventsService
	readonly pluginInfo?: PluginNodeInfo
	readonly caller?: Context
}

/** Host root with root and shared service access. */
export interface RootContext extends Context, BaseRootContext<RootContext> {
	readonly parent?: Context
	/** Log policy, bounded stores and diagnostics; present only with logtape configuration. Core owns installation and shutdown. */
	readonly logging?: RuntimeLogging
}

/** Context owned by one running Plugin generation and shared by its Parts. */
export interface PluginContext extends Context {
	readonly pluginInfo: PluginNodeInfo
	/** Borrow the owning Plugin node's data directory. Rejects with ENOTSUP on a Host without files. */
	readonly fs: (requirement?: FsRequirement) => Promise<FsPromises>
	/** One native Store bridge per Plugin generation, shared with its Parts. */
	readonly tinybase: TinyBaseService
	/** Credentials isolated to the owning Plugin node; storage initializes on the first operation. */
	readonly vault: VaultStorageApi
	/** Native Wretch client using this generation's outbound Fetch. */
	readonly wretch: Wretch
	/** Fetch bound to the generation's lifetime and the Host's outbound configuration. */
	readonly fetch: OutboundFetch
}

/** Built-in facilities shared by direct Core and application Hosts. */
export interface CoreFacilitiesConfig {
	/** Omit to leave logging unmanaged. An empty declaration selects the Core preset. */
	logtape?: LogTapeConfig
	events?: EventsServiceConfig
	/** Native ZenFS mounts shared by Plugin files and state. Omitted means an isolated InMemory root. */
	zenfs?: FsConfig
	/** Snapshot policy for the document storage provided by this Host. */
	tinybase?: TinyBaseOptions
	/** Credential backend and explicit deployment identity. Defaults to lazy encrypted storage. */
	vault?: VaultServiceConfig
	/** Policy and terminal transport shared by all managed outbound clients in this Host. */
	http?: OutboundHttpOptions
}

/** Direct Core configuration. Application Hosts select execution through Host policy. */
export interface CoreHostConfig extends CoreFacilitiesConfig {
	name?: string
	execution?: CoreExecutionConfig
}
