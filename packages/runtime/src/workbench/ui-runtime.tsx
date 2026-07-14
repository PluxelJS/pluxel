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
	AnyWorkbenchExtension,
	WorkbenchCollectionItem,
	WorkbenchCollectionOf,
	WorkbenchEventsOf,
	WorkbenchLayoutItem,
	WorkbenchRpcClient,
	WorkbenchRpcOf,
	WorkbenchViewSpec,
} from './contracts'
import { useGlobalExtensionContext, type ExtensionServices } from '../web/host-ui'
import type { SignalDbListSpec, SignalDbSelector } from './collection-contracts'
import { type SignalDbCollectionView, useSignalDbCollectionState } from './collection-ui-runtime'
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

export interface WorkbenchCollectionClient<TItem extends WorkbenchCollectionItem> {
	useCollection(): SignalDbCollectionView<TItem>
	useOne(selector: SignalDbSelector<TItem>): TItem | undefined
	useOneById(id: string): TItem | undefined
	useMany(spec?: SignalDbListSpec<TItem>): TItem[]
	useCount(selector?: SignalDbSelector<TItem>): number
}

export interface WorkbenchEventsClient<TEvents extends Record<string, unknown>> {
	on<Key extends keyof TEvents & string>(
		event: Key,
		listener: (payload: TEvents[Key]) => void,
	): () => void
	onConnection(listener: (connected: boolean) => void): () => void
}

export type WorkbenchModelClient<Model> = Model extends { kind: 'rpc' }
	? WorkbenchRpcClient<WorkbenchRpcOf<Model>>
	: Model extends { kind: 'collection' }
		? WorkbenchCollectionClient<WorkbenchCollectionOf<Model>>
		: Model extends { kind: 'events' }
			? WorkbenchEventsClient<WorkbenchEventsOf<Model>>
			: never

type ViewModelKeys<
	Extension extends AnyWorkbenchExtension,
	ViewId extends keyof Extension['views'],
> = Extension['views'][ViewId]['model'][number] & keyof Extension['model']

type ViewAcceptedModels<
	Extension extends AnyWorkbenchExtension,
	ViewId extends keyof Extension['views'],
> =
	Extension['views'][ViewId] extends WorkbenchViewSpec<any, infer Models>
		? Models
		: Readonly<Record<never, never>>

type SelectedViewModelClients<
	Extension extends AnyWorkbenchExtension,
	ViewId extends keyof Extension['views'],
> = {
	[Key in ViewModelKeys<Extension, ViewId>]: WorkbenchModelClient<Extension['model'][Key]>
}

type AcceptedViewModelClients<
	Extension extends AnyWorkbenchExtension,
	ViewId extends keyof Extension['views'],
> = {
	[Key in keyof ViewAcceptedModels<Extension, ViewId>]: WorkbenchModelClient<
		ViewAcceptedModels<Extension, ViewId>[Key]
	>
}

export type WorkbenchViewModel<
	Extension extends AnyWorkbenchExtension,
	ViewId extends keyof Extension['views'],
> = Readonly<
	SelectedViewModelClients<Extension, ViewId> & AcceptedViewModelClients<Extension, ViewId>
>

export type WorkbenchModelClients<Extension extends AnyWorkbenchExtension> = Readonly<{
	[Key in keyof Extension['model']]: WorkbenchModelClient<Extension['model'][Key]>
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
	views: Readonly<Record<string, WorkbenchViewComponent>>
	setup?: (ctx: {
		ownerPluginId: string
		locale: ExtensionServices['locale']
	}) => void | (() => void) | Promise<void | (() => void)>
}>

export type WorkbenchUiViews<Extension extends AnyWorkbenchExtension> = Readonly<{
	[ViewId in keyof Extension['views'] & string]: Readonly<{
		useModel(): WorkbenchViewModel<Extension, ViewId>
	}>
}>

export interface WorkbenchUiDefinition<Extension extends AnyWorkbenchExtension> {
	readonly views: WorkbenchUiViews<Extension>
	useModel<Selected>(selector: (model: WorkbenchModelClients<Extension>) => Selected): Selected
	expose<const Views extends Readonly<Record<keyof Extension['views'] & string, ComponentType>>>(
		views: Views,
		options?: Omit<WorkbenchUiModule, 'views'>,
	): Readonly<{ views: Views } & Omit<WorkbenchUiModule, 'views'>>
}

export function createWorkbenchUi<
	const Extension extends AnyWorkbenchExtension,
>(): WorkbenchUiDefinition<Extension> {
	const viewFacades = new Map<string, Readonly<{ useModel(): unknown }>>()
	const views = new Proxy(Object.create(null) as WorkbenchUiViews<Extension>, {
		get(_target, property) {
			if (typeof property !== 'string') return undefined
			let facade = viewFacades.get(property)
			if (!facade) {
				facade = Object.freeze({
					useModel: () => useViewModel<Extension, keyof Extension['views'] & string>(property),
				})
				viewFacades.set(property, facade)
			}
			return facade
		},
	})
	return Object.freeze({
		views,
		useModel<Selected>(selector: (model: WorkbenchModelClients<Extension>) => Selected) {
			if (typeof selector !== 'function') {
				throw new TypeError('[workbench-ui] createWorkbenchUi().useModel(): selector required')
			}
			return selector(useGrantedModel<Extension>())
		},
		expose<const Views extends Readonly<Record<keyof Extension['views'] & string, ComponentType>>>(
			components: Views,
			options: Omit<WorkbenchUiModule, 'views'> = {},
		) {
			if (!components || typeof components !== 'object') {
				throw new Error('[workbench-ui] createWorkbenchUi().expose(): views required')
			}
			for (const [viewId, component] of Object.entries(components)) {
				if (!viewId.trim() || typeof component !== 'function') {
					throw new Error(`[workbench-ui] invalid view export: ${viewId || '<empty>'}`)
				}
			}
			return Object.freeze({ ...options, views: Object.freeze({ ...components }) }) as never
		},
	})
}

function useViewModel<
	Extension extends AnyWorkbenchExtension,
	ViewId extends keyof Extension['views'] & string,
>(viewId: string): WorkbenchViewModel<Extension, ViewId> {
	const item = useWorkbenchView()
	const model = useGrantedModel<Extension>()
	if (item.viewId !== viewId) {
		throw new Error(`[workbench-ui] view "${viewId}" cannot render layout view "${item.viewId}"`)
	}
	return model as WorkbenchViewModel<Extension, ViewId>
}

function useGrantedModel<
	Extension extends AnyWorkbenchExtension,
>(): WorkbenchModelClients<Extension> {
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
		const model: Record<string, unknown> = {}
		for (const [key, ref] of Object.entries(item.model)) {
			switch (ref.kind) {
				case 'rpc':
					model[key] = transport.workbench.rpc(ref.grantId)
					break
				case 'collection':
					model[key] = createCollectionClient(transport, ref.grantId, key)
					break
				case 'events': {
					let stream = eventStreams.get(ref.grantId)
					if (!stream) {
						stream = transport.workbench.events(ref.grantId)
						eventStreams.set(ref.grantId, stream)
					}
					model[key] = createEventsClient(stream)
					break
				}
			}
		}
		return new Proxy(Object.freeze(model), {
			get(target, property, receiver) {
				if (typeof property === 'string' && !(property in target)) {
					throw new Error(
						`[workbench-ui] view "${item.viewId}" was not granted model "${property}"`,
					)
				}
				return Reflect.get(target, property, receiver)
			},
		}) as WorkbenchModelClients<Extension>
	}, [eventStreams, item.model, transport])
}

function createEventsClient<TEvents extends Record<string, unknown>>(
	stream: SseClientWithNamespaces,
): WorkbenchEventsClient<TEvents> {
	return Object.freeze({
		on<Key extends keyof TEvents & string>(event: Key, listener: (payload: TEvents[Key]) => void) {
			return stream.onAny((message: SseMessage<string>) => {
				if (message.event === event) listener(message.payload as TEvents[Key])
			})
		},
		onConnection(listener: (connected: boolean) => void) {
			const stopOpen = stream.onOpen(() => listener(true))
			const stopError = stream.onError(() => listener(false))
			return () => {
				stopOpen()
				stopError()
			}
		},
	})
}

function createCollectionClient<TItem extends WorkbenchCollectionItem>(
	transport: ExtensionServices['transport'],
	grantId: string,
	modelKey: string,
): WorkbenchCollectionClient<TItem> {
	const useCollection = () => useSignalDbCollectionState<TItem>(transport, grantId, modelKey)
	const useOne = (selector: SignalDbSelector<TItem>) => useCollection().findOne(selector)
	const useMany = (spec: SignalDbListSpec<TItem> = {}) => {
		const collection = useCollection()
		return collection.find(spec.where, {
			limit: spec.limit,
			skip: spec.skip,
			sort: spec.sort,
		})
	}
	return Object.freeze({
		useCollection,
		useOne,
		useOneById: (id: string) => useOne({ id } as SignalDbSelector<TItem>),
		useMany,
		useCount: (selector = {} as SignalDbSelector<TItem>) => useCollection().count(selector),
	})
}
