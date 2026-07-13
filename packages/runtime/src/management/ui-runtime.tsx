import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
	type ComponentType,
	type DependencyList,
	type ReactNode,
} from 'react'
import type {
	AnyManagementModule,
	ManagementApiClient,
	ManagementApiOf,
	ManagementCollectionItem,
	ManagementCollectionOf,
	ManagementLayoutItem,
} from './contracts'
import { useGlobalExtensionContext, type ExtensionServices } from '../web/host-ui'
import type { SignalDbListSpec, SignalDbSelector } from './collection-contracts'
import {
	type SignalDbCollectionView,
	useSignalDbCollectionState,
	useSignalDbDocState,
	useSignalDbQueryState,
} from './collection-ui-runtime'
import type { SseClientWithNamespaces } from '../web/sse'

const ManagementViewContext = createContext<ManagementLayoutItem | null>(null)

export function ManagementViewProvider({
	item,
	children,
}: {
	item: ManagementLayoutItem
	children: ReactNode
}) {
	return <ManagementViewContext.Provider value={item}>{children}</ManagementViewContext.Provider>
}

export function useManagementView(): ManagementLayoutItem {
	const value = useContext(ManagementViewContext)
	if (!value) throw new Error('useManagementView() requires a ManagementViewProvider')
	return value
}

type ResourceKeys<
	Module extends { resources: AnyManagementModule['resources'] },
	Kind extends string,
> = Extract<
	{
		[Key in keyof Module['resources']]: Module['resources'][Key] extends { kind: Kind }
			? Key
			: never
	}[keyof Module['resources']],
	string
>

type ManagementResourceHost = Readonly<{
	id: string
	resources: AnyManagementModule['resources']
}>

export interface ManagementCollectionClient<TItem extends ManagementCollectionItem> {
	useView(): SignalDbCollectionView<TItem>
	useDoc(selector: SignalDbSelector<TItem>): TItem | undefined
	useDocById(id: string): TItem | undefined
	useList(spec?: SignalDbListSpec<TItem>): TItem[]
	useCount(selector?: SignalDbSelector<TItem>): number
	useLiveQuery<T>(query: (view: SignalDbCollectionView<TItem>) => T, deps?: DependencyList): T
}

export type ManagementApp<Module extends ManagementResourceHost> = Readonly<{
	module: Module
	owner: string
	target: string
	colorScheme: 'light' | 'dark'
	locale: string
	notify: ExtensionServices['ui']['notify']
	confirm: ExtensionServices['ui']['confirm']
	api<Key extends ResourceKeys<Module, 'api'>>(
		key: Key,
	): ManagementApiClient<ManagementApiOf<Module['resources'][Key]>>
	collection<Key extends ResourceKeys<Module, 'collection'>>(
		key: Key,
	): ManagementCollectionClient<ManagementCollectionOf<Module['resources'][Key]>>
	stream<Key extends ResourceKeys<Module, 'stream'>>(key: Key): SseClientWithNamespaces
}>

export interface ManagementAppDefinition<Module extends ManagementResourceHost> {
	use(): ManagementApp<Module>
	define<const Views extends Readonly<Record<string, ManagementViewComponent>>>(
		views: Views,
		options?: Omit<ManagementUiModule, 'views'>,
	): Readonly<{ views: Views } & Omit<ManagementUiModule, 'views'>>
}

export type ManagementViewComponent = ComponentType

export type ManagementUiModule = Readonly<{
	views: Readonly<Record<string, ManagementViewComponent>>
	setup?: (ctx: {
		owner: string
		locale: ExtensionServices['locale']
	}) => void | (() => void) | Promise<void | (() => void)>
}>

function validateManagementUiModule<const Module extends ManagementUiModule>(
	module: Module,
): Module {
	if (!module || typeof module !== 'object' || !module.views) {
		throw new Error('[management-ui] managementApp().define(): views required')
	}
	for (const [key, view] of Object.entries(module.views)) {
		if (!key.trim() || typeof view !== 'function') {
			throw new Error(`[management-ui] invalid view export: ${key || '<empty>'}`)
		}
	}
	return Object.freeze({
		...module,
		views: Object.freeze({ ...module.views }),
	}) as Module
}

export function managementApp<const Module extends ManagementResourceHost>(
	module: Module,
): ManagementAppDefinition<Module> {
	return Object.freeze({
		define(views, options = {}) {
			return validateManagementUiModule({ ...options, views })
		},
		use() {
			const item = useManagementView()
			const context = useGlobalExtensionContext()
			const locale = useSyncExternalStore(
				(listener) => context.services.locale.subscribe(listener),
				() => context.services.locale.locale,
				() => context.services.locale.locale,
			)
			const transport = context.services.transport
			const streamClients = useMemo(
				() => new Map<string, SseClientWithNamespaces>(),
				[item, transport],
			)
			useEffect(
				() => () => {
					for (const stream of streamClients.values()) stream.close()
					streamClients.clear()
				},
				[streamClients],
			)
			const resource = (key: string) => {
				const ref = item.resources[key]
				if (!ref) {
					throw new Error(
						`[management-ui] resource binding "${key}" is unavailable for view "${item.id}"`,
					)
				}
				return ref
			}
			const collection = <Key extends ResourceKeys<Module, 'collection'>>(
				key: Key,
			): ManagementCollectionClient<ManagementCollectionOf<Module['resources'][Key]>> => {
				const ref = resource(String(key))
				if (ref.kind !== 'collection') throw resourceKindError(String(key), 'collection', ref.kind)
				return createCollectionClient(
					transport,
					ref.binding,
					String(key),
				) as ManagementCollectionClient<ManagementCollectionOf<Module['resources'][Key]>>
			}

			return useMemo(
				() => ({
					module,
					owner: item.owner,
					target: item.target,
					colorScheme: context.colorScheme,
					locale,
					notify: context.services.ui.notify,
					confirm: context.services.ui.confirm,
					api: (key) => {
						const ref = resource(String(key))
						if (ref.kind !== 'api') throw resourceKindError(String(key), 'api', ref.kind)
						return transport.management.api(ref.binding)
					},
					collection,
					stream: (key) => {
						const ref = resource(String(key))
						if (ref.kind !== 'stream') throw resourceKindError(String(key), 'stream', ref.kind)
						let stream = streamClients.get(ref.binding)
						if (!stream) {
							stream = transport.management.stream(ref.binding)
							streamClients.set(ref.binding, stream)
						}
						return stream
					},
				}),
				[context, item, locale, streamClients, transport],
			) as ManagementApp<Module>
		},
	})
}

function resourceKindError(key: string, expected: string, actual: string): Error {
	return new Error(`[management-ui] resource binding "${key}" requires ${expected}, got ${actual}`)
}

function createCollectionClient<TItem extends ManagementCollectionItem>(
	transport: ExtensionServices['transport'],
	binding: string,
	resource: string,
): ManagementCollectionClient<TItem> {
	const useView = () => useSignalDbCollectionState<TItem>(transport, binding, resource)
	const useDoc = (selector: SignalDbSelector<TItem>) =>
		useSignalDbDocState<TItem>(transport, binding, resource, selector)
	const useList = (spec: SignalDbListSpec<TItem> = {}) => {
		const view = useView()
		return useSignalDbQueryState(
			() =>
				view.find(spec.where, {
					limit: spec.limit,
					skip: spec.skip,
					sort: spec.sort,
				}),
			[view, spec],
		)
	}
	return {
		useView,
		useDoc,
		useDocById: (id) => useDoc({ id } as SignalDbSelector<TItem>),
		useList,
		useCount: (selector = {} as SignalDbSelector<TItem>) => {
			const view = useView()
			return useSignalDbQueryState(() => view.count(selector), [view, selector])
		},
		useLiveQuery: (query, deps = []) => {
			const view = useView()
			return useSignalDbQueryState(() => query(view), [view, ...deps])
		},
	}
}
