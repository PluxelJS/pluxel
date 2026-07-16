import type { Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import type {
	AnyWorkbenchContract,
	WorkbenchCollectionItem,
	WorkbenchCollectionResource,
	WorkbenchEventsOf,
	WorkbenchResourceContract,
	WorkbenchRpcOf,
} from './contracts'
import type { SignalDbCollectionHandle } from '../services/workbench/resources/WorkbenchCollectionService'
import type { SseHandler } from '../services/workbench/resources/WorkbenchEventsService'
import { createWorkbenchUiEntry, type WorkbenchUiEntry } from './ui-entry'
export type { WorkbenchUiEntry } from './ui-entry'

export type WorkbenchExtension<Contract extends AnyWorkbenchContract = AnyWorkbenchContract> =
	Readonly<{
		contract: Contract
		entry?: WorkbenchUiEntry
	}>

export type AnyWorkbenchExtension = WorkbenchExtension<any>

export type WorkbenchRpcBinding<TRpc> = Readonly<{
	kind: 'rpc'
	factory: (ctx: Context) => TRpc
}>

export type WorkbenchManagedCollectionBinding<TItem extends WorkbenchCollectionItem> = Readonly<{
	kind: 'collection'
	mode: 'managed'
	options: Readonly<{
		storage?: 'memory' | 'plugin-data'
		initial?: TItem[] | (() => TItem[])
	}>
}>

export type WorkbenchProjectedCollectionBinding<TItem extends WorkbenchCollectionItem> = Readonly<{
	kind: 'collection'
	mode: 'projection'
	read: () => readonly TItem[]
	subscribe?: (invalidate: () => void) => void | (() => void)
}>

export type WorkbenchEventMap = Readonly<Record<string, unknown>>

export type WorkbenchEventsContext<TEvents extends WorkbenchEventMap> = Readonly<{
	emit<Key extends keyof TEvents & string>(event: Key, payload: TEvents[Key]): void
	signal: AbortSignal
}>

export type WorkbenchEventsBinding<TEvents extends WorkbenchEventMap> = Readonly<{
	kind: 'events'
	handler: SseHandler
	readonly __events?: TEvents
}>

export type WorkbenchResourceBinding<Resource extends WorkbenchResourceContract> =
	Resource extends { kind: 'rpc' }
		? WorkbenchRpcBinding<WorkbenchRpcOf<Resource>>
		: Resource extends WorkbenchCollectionResource<infer TItem>
			? WorkbenchManagedCollectionBinding<TItem> | WorkbenchProjectedCollectionBinding<TItem>
			: Resource extends { kind: 'events' }
				? WorkbenchEventsBinding<WorkbenchEventsOf<Resource>>
				: never

export type WorkbenchBindings<Extension extends AnyWorkbenchExtension> = {
	[Key in keyof Extension['contract']['resources']]: WorkbenchResourceBinding<
		Extension['contract']['resources'][Key]
	>
}

export type MountedWorkbenchManagedCollections<
	Extension extends AnyWorkbenchExtension,
	Bindings extends WorkbenchBindings<Extension> = never,
> = [Bindings] extends [never]
	? {
			[Key in keyof Extension['contract']['resources'] as Extension['contract']['resources'][Key] extends WorkbenchCollectionResource<any>
				? Key
				: never]: Extension['contract']['resources'][Key] extends WorkbenchCollectionResource<
				infer TItem
			>
				? SignalDbCollectionHandle<TItem>
				: never
		}
	: {
			[Key in keyof Bindings as Bindings[Key] extends WorkbenchManagedCollectionBinding<any>
				? Key
				: never]: Key extends keyof Extension['contract']['resources']
				? Extension['contract']['resources'][Key] extends WorkbenchCollectionResource<infer TItem>
					? SignalDbCollectionHandle<TItem>
					: never
				: never
		}

export type WorkbenchMount<
	Extension extends AnyWorkbenchExtension,
	Bindings extends WorkbenchBindings<Extension>,
> = Readonly<{
	extension: Extension
	managedCollections: MountedWorkbenchManagedCollections<Extension, Bindings>
}>

function extension<const Contract extends AnyWorkbenchContract>(input: {
	contract: Contract
	entry?: WorkbenchUiEntry
}): WorkbenchExtension<Contract> {
	if (!input.contract || typeof input.contract !== 'object') {
		throw new TypeError('[workbench] workbench.extension(): contract required')
	}
	return Object.freeze({ contract: input.contract, entry: input.entry })
}

const bind = Object.freeze({
	rpc<TRpc extends RpcTarget>(factory: (ctx: Context) => TRpc): WorkbenchRpcBinding<TRpc> {
		if (typeof factory !== 'function') {
			throw new TypeError('[workbench] workbench.bind.rpc(): factory required')
		}
		return Object.freeze({ kind: 'rpc', factory })
	},
	collection<TItem extends WorkbenchCollectionItem>(input: {
		read: () => readonly TItem[]
		subscribe?: (invalidate: () => void) => void | (() => void)
	}): WorkbenchProjectedCollectionBinding<TItem> {
		if (typeof input?.read !== 'function') {
			throw new TypeError('[workbench] workbench.bind.collection(): read required')
		}
		return Object.freeze({
			kind: 'collection',
			mode: 'projection',
			read: input.read,
			subscribe: input.subscribe,
		})
	},
	managedCollection<TItem extends WorkbenchCollectionItem>(
		options: {
			storage?: 'memory' | 'plugin-data'
			initial?: TItem[] | (() => TItem[])
		} = {},
	): WorkbenchManagedCollectionBinding<TItem> {
		return Object.freeze({
			kind: 'collection',
			mode: 'managed',
			options: Object.freeze({ ...options }),
		})
	},
	events<TEvents extends WorkbenchEventMap>(
		handler: (
			context: WorkbenchEventsContext<TEvents>,
		) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>,
	): WorkbenchEventsBinding<TEvents> {
		return Object.freeze({
			kind: 'events',
			handler: (channel) => {
				const controller = new AbortController()
				channel.onAbort(() => controller.abort())
				return handler({
					emit: (event, payload) => channel.emit(event, payload),
					signal: controller.signal,
				})
			},
		})
	},
})

export const workbench = Object.freeze({
	extension,
	entry(moduleUrl: string | URL, entryPath: string): WorkbenchUiEntry {
		return createWorkbenchUiEntry(moduleUrl, entryPath, arguments[2])
	},
	bind,
})

export interface PluginWorkbench {
	mount<
		Extension extends AnyWorkbenchExtension,
		const Bindings extends WorkbenchBindings<Extension>,
	>(
		extension: Extension,
		bindings: Bindings,
	): WorkbenchMount<Extension, Bindings>
}
