import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
	type ComponentType,
	type ReactNode,
} from 'react'
import type {
	AnyWorkbenchContract,
	WorkbenchCollectionItem,
	WorkbenchCollectionOf,
	WorkbenchEventsOf,
	WorkbenchLayoutItem,
	WorkbenchPortContract,
	WorkbenchResourceMap,
	WorkbenchResourceRef,
	WorkbenchRpcClient,
	WorkbenchRpcOf,
} from './contracts'
import { useGlobalExtensionContext, type ExtensionServices } from '../web/host-ui'
import { useSignalDbCollectionState } from './collection-ui-runtime'
import type { SseClientWithNamespaces, SseMessage } from '../web/sse'

const WorkbenchViewContext = createContext<WorkbenchLayoutItem | null>(null)

export function WorkbenchViewProvider({
	item,
	children,
}: {
	item: WorkbenchLayoutItem
	children: ReactNode
}) {
	return <WorkbenchViewContext.Provider value={item}>{children}</WorkbenchViewContext.Provider>
}

export function useWorkbenchView(): WorkbenchLayoutItem {
	const value = useContext(WorkbenchViewContext)
	if (!value) throw new Error('useWorkbenchView() requires a WorkbenchViewProvider')
	return value
}

export type WorkbenchCollectionSnapshot<TItem extends WorkbenchCollectionItem> =
	| Readonly<{
			state: 'loading'
			items: readonly TItem[]
			error: null
			refresh(): Promise<void>
	  }>
	| Readonly<{
			state: 'ready'
			items: readonly TItem[]
			error: null
			refresh(): Promise<void>
	  }>
	| Readonly<{
			state: 'stale'
			items: readonly TItem[]
			error: Error
			refresh(): Promise<void>
	  }>
	| Readonly<{
			state: 'error'
			items: readonly TItem[]
			error: Error
			refresh(): Promise<void>
	  }>

export interface WorkbenchCollectionClient<TItem extends WorkbenchCollectionItem> {
	useSnapshot(): WorkbenchCollectionSnapshot<TItem>
}

export type WorkbenchEventConnectionState = Readonly<{
	state: 'connecting' | 'connected' | 'error'
	error: Error | null
}>

export interface WorkbenchEventsClient<TEvents extends Record<string, unknown>> {
	subscribe<Key extends keyof TEvents & string>(
		event: Key,
		listener: (payload: TEvents[Key]) => void,
	): () => void
	useConnectionState(): WorkbenchEventConnectionState
}

export type WorkbenchResourceClient<Resource> = Resource extends { kind: 'rpc' }
	? WorkbenchRpcClient<WorkbenchRpcOf<Resource>>
	: Resource extends { kind: 'collection' }
		? WorkbenchCollectionClient<WorkbenchCollectionOf<Resource>>
		: Resource extends { kind: 'events' }
			? WorkbenchEventsClient<WorkbenchEventsOf<Resource>>
			: never

export type WorkbenchResourceClients<Resources extends WorkbenchResourceMap> = Readonly<{
	[Key in keyof Resources]: WorkbenchResourceClient<Resources[Key]>
}>

export type WorkbenchHost = Readonly<{
	ownerPluginId: string
	targetPluginId: string
	colorScheme: 'light' | 'dark'
	locale: string
	notify: ExtensionServices['ui']['notify']
	confirm: ExtensionServices['ui']['confirm']
}>

export function useWorkbenchHost(): WorkbenchHost {
	const item = useWorkbenchView()
	const context = useGlobalExtensionContext()
	const locale = useSyncExternalStore(
		(listener) => context.services.locale.subscribe(listener),
		() => context.services.locale.locale,
		() => context.services.locale.locale,
	)
	return useMemo(
		() => ({
			ownerPluginId: item.ownerPluginId,
			targetPluginId: item.targetPluginId,
			colorScheme: context.colorScheme,
			locale,
			notify: context.services.ui.notify,
			confirm: context.services.ui.confirm,
		}),
		[context, item.ownerPluginId, item.targetPluginId, locale],
	)
}

export type WorkbenchViewComponent = ComponentType

export type WorkbenchUiModule = Readonly<{
	contractFingerprint: string
	views: Readonly<Record<string, WorkbenchViewComponent>>
	setup?: (ctx: {
		ownerPluginId: string
		locale: ExtensionServices['locale']
	}) => void | (() => void) | Promise<void | (() => void)>
}>

type RemoteViewKeys<Contract extends AnyWorkbenchContract> = {
	[Key in keyof Contract['views'] & string]: Contract['views'][Key] extends {
		view: { kind: 'builtin' }
	}
		? never
		: Key
}[keyof Contract['views'] & string]

export interface WorkbenchUiDefinition<Contract extends AnyWorkbenchContract> {
	useResources(): WorkbenchResourceClients<Contract['resources']>
	usePort<Port extends WorkbenchPortContract<any>>(
		port: Port,
	): WorkbenchResourceClients<Port['resources']>
	define<const Views extends Readonly<Record<RemoteViewKeys<Contract>, ComponentType>>>(
		views: Views & Readonly<Record<Exclude<keyof Views, RemoteViewKeys<Contract>>, never>>,
		options?: Omit<WorkbenchUiModule, 'views' | 'contractFingerprint'>,
	): Readonly<{ views: Views } & Omit<WorkbenchUiModule, 'views'>>
}

export function createWorkbenchUi<const Contract extends AnyWorkbenchContract>(
	contract: Contract,
): WorkbenchUiDefinition<Contract> {
	if (!contract || typeof contract !== 'object') {
		throw new Error('[workbench-ui] createWorkbenchUi(): Contract value required')
	}
	return Object.freeze({
		useResources() {
			const item = useWorkbenchView()
			return useGrantedResources<Contract['resources']>(item.model)
		},
		usePort<Port extends WorkbenchPortContract<any>>(port: Port) {
			const item = useWorkbenchView()
			if (!item.port || item.port.id !== port.id || item.port.version !== port.version) {
				throw new Error(
					`[workbench-ui] current View does not accept Port "${port.id}" v${port.version}`,
				)
			}
			return useGrantedResources<Port['resources']>(item.port.model)
		},
		define<const Views extends Readonly<Record<RemoteViewKeys<Contract>, ComponentType>>>(
			components: Views & Readonly<Record<Exclude<keyof Views, RemoteViewKeys<Contract>>, never>>,
			options: Omit<WorkbenchUiModule, 'views' | 'contractFingerprint'> = {},
		) {
			if (!components || typeof components !== 'object') {
				throw new Error('[workbench-ui] createWorkbenchUi().define(): views required')
			}
			const expected = (
				Object.entries(contract.views) as Array<
					[string, Contract['views'][keyof Contract['views']]]
				>
			)
				.filter(([, view]) => view.view?.kind !== 'builtin')
				.map(([viewId]) => viewId)
				.sort()
			const actual = Object.keys(components).sort()
			if (expected.join('\0') !== actual.join('\0')) {
				throw new Error(
					`[workbench-ui] View exports must exactly match Contract; expected ${expected.join(', ') || '<none>'}`,
				)
			}
			for (const [viewId, component] of Object.entries(components)) {
				if (!viewId.trim() || typeof component !== 'function') {
					throw new Error(`[workbench-ui] invalid View export: ${viewId || '<empty>'}`)
				}
			}
			return Object.freeze({
				...options,
				contractFingerprint: contract.fingerprint,
				views: Object.freeze({ ...components }),
			}) as never
		},
	})
}

function useGrantedResources<Resources extends WorkbenchResourceMap>(
	refs: Readonly<Record<string, WorkbenchResourceRef>>,
): WorkbenchResourceClients<Resources> {
	const item = useWorkbenchView()
	const context = useGlobalExtensionContext()
	const transport = context.services.transport
	const eventStreams = useMemo(() => new Map<string, SseClientWithNamespaces>(), [item, transport])
	useEffect(
		() => () => {
			for (const stream of eventStreams.values()) stream.close()
			eventStreams.clear()
		},
		[eventStreams],
	)

	return useMemo(() => {
		const resources: Record<string, unknown> = {}
		for (const [key, ref] of Object.entries(refs)) {
			switch (ref.kind) {
				case 'rpc':
					resources[key] = transport.workbench.rpc(ref.grantId)
					break
				case 'collection':
					resources[key] = createCollectionClient(transport, ref.grantId, key)
					break
				case 'events':
					resources[key] = createEventsClient(() => {
						let stream = eventStreams.get(ref.grantId)
						if (!stream) {
							stream = transport.workbench.events(ref.grantId)
							eventStreams.set(ref.grantId, stream)
						}
						return stream
					})
					break
			}
		}
		return new Proxy(Object.freeze(resources), {
			get(target, property, receiver) {
				if (typeof property === 'string' && !(property in target)) {
					throw new Error(
						`[workbench-ui] View "${item.viewId}" was not granted resource "${property}"`,
					)
				}
				return Reflect.get(target, property, receiver)
			},
		}) as WorkbenchResourceClients<Resources>
	}, [eventStreams, item.viewId, refs, transport])
}

function createCollectionClient<TItem extends WorkbenchCollectionItem>(
	transport: ExtensionServices['transport'],
	grantId: string,
	resourceKey: string,
): WorkbenchCollectionClient<TItem> {
	return Object.freeze({
		useSnapshot(): WorkbenchCollectionSnapshot<TItem> {
			const collection = useSignalDbCollectionState<TItem>(transport, grantId, resourceKey)
			const items = collection.items
			const refresh = () => collection.refresh()
			if (collection.ready) {
				return Object.freeze({ state: 'ready', items, error: null, refresh })
			}
			if (collection.error) {
				return Object.freeze({
					state: items.length > 0 ? 'stale' : 'error',
					items,
					error: collection.error,
					refresh,
				}) as WorkbenchCollectionSnapshot<TItem>
			}
			return Object.freeze({ state: 'loading', items, error: null, refresh })
		},
	})
}

function createEventsClient<TEvents extends Record<string, unknown>>(
	getStream: () => SseClientWithNamespaces,
): WorkbenchEventsClient<TEvents> {
	let state: WorkbenchEventConnectionState = Object.freeze({ state: 'connecting', error: null })
	const listeners = new Set<() => void>()
	let observed = false
	const notify = (next: WorkbenchEventConnectionState) => {
		state = Object.freeze(next)
		for (const listener of listeners) listener()
	}
	const observe = () => {
		const stream = getStream()
		if (!observed) {
			observed = true
			stream.onOpen(() => notify({ state: 'connected', error: null }))
			stream.onError(() =>
				notify({ state: 'error', error: new Error('event stream disconnected') }),
			)
		}
		return stream
	}
	return Object.freeze({
		subscribe<Key extends keyof TEvents & string>(
			event: Key,
			listener: (payload: TEvents[Key]) => void,
		) {
			return observe().onAny((message: SseMessage<string>) => {
				if (message.event === event) listener(message.payload as TEvents[Key])
			})
		},
		useConnectionState() {
			return useSyncExternalStore(
				(listener) => {
					listeners.add(listener)
					observe()
					return () => listeners.delete(listener)
				},
				() => state,
				() => state,
			)
		},
	})
}
