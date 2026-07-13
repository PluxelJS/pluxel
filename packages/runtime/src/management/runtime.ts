import type { Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import type {
	AnyManagementModule,
	ManagementApiOf,
	ManagementCollectionItem,
	ManagementCollectionResource,
	ManagementResourceContract,
	ManagementStreamOf,
} from './contracts'
import type {
	SignalDbCollectionHandle,
	SignalDbCollectionOptions,
} from '../services/management/resources/ManagementCollectionService'
import type { SseHandler } from '../services/management/resources/ManagementStreamService'

export type ManagementApiBinding<TApi> = Readonly<{
	kind: 'api'
	factory: (ctx: Context) => TApi
}>

export type ManagementCollectionBinding<TItem extends ManagementCollectionItem> = Readonly<{
	kind: 'collection'
	options: Omit<SignalDbCollectionOptions<TItem>, 'name'>
}>

export type ManagementStreamBinding<TEvent> = Readonly<{
	kind: 'stream'
	handler: SseHandler
	readonly __event?: TEvent
}>

export type ManagementResourceBinding<Resource extends ManagementResourceContract> =
	Resource extends { kind: 'api' }
		? ManagementApiBinding<ManagementApiOf<Resource>>
		: Resource extends ManagementCollectionResource<infer TItem>
			? ManagementCollectionBinding<TItem>
			: Resource extends { kind: 'stream' }
				? ManagementStreamBinding<ManagementStreamOf<Resource>>
				: never

export type ManagementBindings<Module extends AnyManagementModule> = {
	[Key in keyof Module['resources']]: ManagementResourceBinding<Module['resources'][Key]>
}

export type MountedManagementResources<Module extends AnyManagementModule> = {
	[Key in keyof Module['resources']]: Module['resources'][Key] extends ManagementCollectionResource<
		infer TItem
	>
		? SignalDbCollectionHandle<TItem>
		: undefined
}

export type ManagementMount<Module extends AnyManagementModule> = Readonly<{
	module: Module
	resources: MountedManagementResources<Module>
	dispose(): void
}>

export const managementBinding = {
	api<TApi extends RpcTarget>(factory: (ctx: Context) => TApi): ManagementApiBinding<TApi> {
		return Object.freeze({ kind: 'api', factory })
	},
	collection<TItem extends ManagementCollectionItem>(
		options: Omit<SignalDbCollectionOptions<TItem>, 'name'> = {},
	): ManagementCollectionBinding<TItem> {
		return Object.freeze({ kind: 'collection', options: Object.freeze({ ...options }) })
	},
	stream<TEvent>(handler: SseHandler): ManagementStreamBinding<TEvent> {
		return Object.freeze({ kind: 'stream', handler })
	},
} as const

export interface PluginManagement {
	mount<Module extends AnyManagementModule>(
		module: Module,
		bindings: ManagementBindings<Module>,
	): ManagementMount<Module>
}
