import type { PluginNodeAddress } from '@pluxel/core'
import type { HostDocumentStorage } from '@pluxel/host'
import type { Store } from 'tinybase'
import type { OptionalSchemas, Store as SchemaStore } from 'tinybase/with-schemas'

/** A Plugin generation's single native Store. Parts and dependency views share this handle. */
export interface TinyBaseService {
	/** Restore before use. A supplied Store must be fresh, ordinary and have no listeners or open transaction. */
	open(): Promise<Store>
	open<TStore extends Store>(store: TStore): Promise<TStore>
	open<TSchemas extends OptionalSchemas>(
		store: SchemaStore<TSchemas>,
	): Promise<SchemaStore<TSchemas>>
	/** Wait for the last complete transaction at this call. Native mutations alone do not confirm persistence. */
	flush(): Promise<void>
}

export type TinyBaseIdentity =
	| Readonly<{ kind: 'plugin'; node: PluginNodeAddress }>
	| Readonly<{ kind: 'host'; namespace: string }>

export type TinyBaseStatus = Readonly<{
	identity: TinyBaseIdentity
	phase: 'opening' | 'initializing' | 'active' | 'faulted' | 'closed'
	revision: number
	savedRevision: number
	pendingRevision: number | undefined
	/** A save failure may have committed before the backend reported failure. */
	outcome: 'confirmed' | 'unknown'
	error?: unknown
}>

/** Host-only document storage and diagnostics. It never exposes a Plugin's mutable Store. */
export interface TinyBaseHostService {
	/** Pure borrowed adapter. All documents in a namespace commit through one serial writer. */
	documents(namespace: string): HostDocumentStorage
	status(): readonly TinyBaseStatus[]
	/** Stop the Plugin first. Retry the retained snapshot or discard it and inspect the actual backing. */
	recover(node: PluginNodeAddress, action: 'retry' | 'discard'): Promise<void>
}

/** Host policy; Plugin authors do not choose persistence paths or backends. */
export type TinyBaseOptions = Readonly<{
	/** Maximum UTF-8 bytes per complete envelope, including Host documents. @defaultValue 8388608 */
	maxSnapshotBytes?: number
}>
