import type { Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import {
	workbenchDefinition,
	type AnyWorkbenchExtension,
	type WorkbenchCollectionItem,
	type WorkbenchCollectionModel,
	type WorkbenchEventsOf,
	type WorkbenchModelContract,
	type WorkbenchRpcOf,
} from './contracts'
import type {
	SignalDbCollectionHandle,
	SignalDbCollectionOptions,
} from '../services/workbench/resources/WorkbenchCollectionService'
import type { SseHandler } from '../services/workbench/resources/WorkbenchEventsService'

export type WorkbenchRpcProvider<TRpc> = Readonly<{
	kind: 'rpc'
	factory: (ctx: Context) => TRpc
}>

export type WorkbenchCollectionProvider<TItem extends WorkbenchCollectionItem> = Readonly<{
	kind: 'collection'
	options: Omit<SignalDbCollectionOptions<TItem>, 'name' | 'persistence' | 'clientWrites'>
}>

export type WorkbenchEventMap = Readonly<Record<string, unknown>>

export type WorkbenchEventsContext<TEvents extends WorkbenchEventMap> = Readonly<{
	emit<Key extends keyof TEvents & string>(event: Key, payload: TEvents[Key]): void
	signal: AbortSignal
}>

export type WorkbenchEventsProvider<TEvents extends WorkbenchEventMap> = Readonly<{
	kind: 'events'
	handler: SseHandler
	readonly __events?: TEvents
}>

export type WorkbenchModelProvider<Model extends WorkbenchModelContract> = Model extends {
	kind: 'rpc'
}
	? WorkbenchRpcProvider<WorkbenchRpcOf<Model>>
	: Model extends WorkbenchCollectionModel<infer TItem>
		? WorkbenchCollectionProvider<TItem>
		: Model extends { kind: 'events' }
			? WorkbenchEventsProvider<WorkbenchEventsOf<Model>>
			: never

export type WorkbenchProviders<Extension extends AnyWorkbenchExtension> = {
	[Key in keyof Extension['model']]: WorkbenchModelProvider<Extension['model'][Key]>
}

export type MountedWorkbenchCollections<Extension extends AnyWorkbenchExtension> = {
	[Key in keyof Extension['model'] as Extension['model'][Key] extends WorkbenchCollectionModel<any>
		? Key
		: never]: Extension['model'][Key] extends WorkbenchCollectionModel<infer TItem>
		? SignalDbCollectionHandle<TItem>
		: never
}

export type WorkbenchMount<Extension extends AnyWorkbenchExtension> = Readonly<{
	extension: Extension
	collections: MountedWorkbenchCollections<Extension>
	dispose(): void
}>

const workbenchProvide = Object.freeze({
	rpc<TRpc extends RpcTarget>(factory: (ctx: Context) => TRpc): WorkbenchRpcProvider<TRpc> {
		return Object.freeze({ kind: 'rpc', factory })
	},
	collection<TItem extends WorkbenchCollectionItem>(
		options: {
			storage?: 'memory' | 'plugin-data'
			uiAccess?: 'read' | 'write'
			initial?: TItem[] | (() => TItem[])
		} = {},
	): WorkbenchCollectionProvider<TItem> {
		return Object.freeze({
			kind: 'collection',
			options: Object.freeze({
				initial: options.initial,
				persistence: options.storage === 'plugin-data',
				clientWrites: options.uiAccess === 'write',
			} as never),
		})
	},
	events<TEvents extends WorkbenchEventMap>(
		handler: (
			context: WorkbenchEventsContext<TEvents>,
		) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>,
	): WorkbenchEventsProvider<TEvents> {
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
	...workbenchDefinition,
	provide: workbenchProvide,
})

export interface PluginWorkbench {
	mount<Extension extends AnyWorkbenchExtension>(
		extension: Extension,
		providers: WorkbenchProviders<Extension>,
	): WorkbenchMount<Extension>
}
