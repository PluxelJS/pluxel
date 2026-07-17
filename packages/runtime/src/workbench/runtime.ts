import type { Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import type {
	AnyWorkbenchContract,
	WorkbenchEventsOf,
	WorkbenchLiveQueryOf,
	WorkbenchLiveQueryResource,
	WorkbenchResourceContract,
	WorkbenchRpcOf,
} from './contracts'
import type { DatabaseDefinition, PluginDatabaseClient, PluginDatabaseHandle } from '../database'
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

export type WorkbenchLiveQueryBinding<Params, Row> = Readonly<{
	kind: 'liveQuery'
	database: PluginDatabaseHandle<any>
	dependsOn: readonly unknown[]
	query: (db: any, params: Params) => readonly Row[] | Promise<readonly Row[]>
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
		: Resource extends WorkbenchLiveQueryResource<any, any>
			? WorkbenchLiveQueryBinding<
					WorkbenchLiveQueryOf<Resource>['params'],
					WorkbenchLiveQueryOf<Resource>['row']
				>
			: Resource extends { kind: 'events' }
				? WorkbenchEventsBinding<WorkbenchEventsOf<Resource>>
				: never

export type WorkbenchBindings<Extension extends AnyWorkbenchExtension> = {
	[Key in keyof Extension['contract']['resources']]: WorkbenchResourceBinding<
		Extension['contract']['resources'][Key]
	>
}

export type WorkbenchMount<
	Extension extends AnyWorkbenchExtension,
	_Bindings extends WorkbenchBindings<Extension>,
> = Readonly<{
	extension: Extension
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
	liveQuery<Definition extends DatabaseDefinition, Params, Row>(
		input: Readonly<{
			database: PluginDatabaseHandle<Definition>
			dependsOn: readonly unknown[]
			query: (
				db: PluginDatabaseClient<Definition>,
				params: Params,
			) => readonly Row[] | Promise<readonly Row[]>
		}>,
	): WorkbenchLiveQueryBinding<Params, Row> {
		if (!input?.database || !Array.isArray(input.dependsOn) || typeof input.query !== 'function') {
			throw new TypeError(
				'[workbench] workbench.bind.liveQuery() requires database, dependsOn, and query',
			)
		}
		return Object.freeze({ kind: 'liveQuery', ...input }) as WorkbenchLiveQueryBinding<Params, Row>
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
