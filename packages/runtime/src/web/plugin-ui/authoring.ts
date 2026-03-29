import type { DependencyList } from 'react'
import { useMemo, useSyncExternalStore } from 'react'
import type {
	ExtensionContext,
	ExtensionServices,
	GlobalExtensionContext,
	PluginExtensionContext,
} from './ui-contracts'
import {
	useGlobalExtensionContext,
	usePluginExtensionContext,
} from './ui-contracts'
import type { RuntimeTransportClient } from '../client'
import type { ExtensionUiRpcMap, ExtensionUiSignalDbMap } from '../protocol'
import type {
	SignalDbFindOptions,
	SignalDbItem,
	SignalDbListSpec,
	SignalDbSelector,
} from './signaldb-contracts'
import type { SseNamespaceClient } from '../sse'
import {
	type SignalDbCollectionView,
	useSignalDbCollectionState,
	useSignalDbDocState,
	useSignalDbQueryState,
} from './signaldb-runtime'

type HostUiService = ExtensionServices['ui']

type PluginUiRpc<Name extends string> = Name extends keyof ExtensionUiRpcMap
	? ExtensionUiRpcMap[Name]
	: never

type PluginUiSignalDb<Name extends string> = Name extends keyof ExtensionUiSignalDbMap
	? ExtensionUiSignalDbMap[Name]
	: Record<string, SignalDbItem>

type PluginUiCollectionKey<Name extends string> = Extract<keyof PluginUiSignalDb<Name>, string>

type PluginUiCollectionItem<
	Name extends string,
	Key extends PluginUiCollectionKey<Name>,
> = PluginUiSignalDb<Name>[Key] extends SignalDbItem ? PluginUiSignalDb<Name>[Key] : SignalDbItem

type PluginUiContext<Name extends string> = PluginExtensionContext & { pluginName: Name }

/**
 * SignalDB browser-side facade for one plugin namespace.
 */
export type PluginUiDb<Name extends string> = Readonly<{
	collection<Key extends PluginUiCollectionKey<Name>>(name: Key): PluginUiCollection<Name, Key>
	useDocById<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		id: string,
	): PluginUiCollectionItem<Name, Key> | undefined
	useDoc<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<PluginUiCollectionItem<Name, Key>>,
	): PluginUiCollectionItem<Name, Key> | undefined
	useList<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		spec?: SignalDbListSpec<PluginUiCollectionItem<Name, Key>>,
	): PluginUiCollectionItem<Name, Key>[]
	useCount<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		selector?: SignalDbSelector<PluginUiCollectionItem<Name, Key>>,
	): number
	useLiveQuery<T>(query: () => T, deps?: DependencyList): T
}>

/**
 * Unified browser-side app surface for one plugin namespace.
 *
 * The common authoring path is:
 * - `const plugin = pluginUi('MyPlugin')`
 * - `const app = plugin.use()`
 * - `app.rpc / app.sse / app.db / app.notify / app.colorScheme`
 */
export type PluginUiApp<
	Name extends string,
	Ctx extends ExtensionContext = ExtensionContext,
> = Readonly<{
	pluginName: Name
	pathname: Ctx extends PluginExtensionContext ? string : string | null
	colorScheme: Ctx['colorScheme']
	runningPlugins: ReadonlySet<string>
	runningPluginsReady: boolean
	locale: ExtensionServices['locale']['locale']
	fallbackLocale: ExtensionServices['locale']['fallbackLocale']
	setLocale: ExtensionServices['locale']['setLocale']
	formatDate: ExtensionServices['locale']['formatDate']
	formatNumber: ExtensionServices['locale']['formatNumber']
	transport: RuntimeTransportClient
	rpc: PluginUiRpc<Name>
	sse: SseNamespaceClient<Name>
	notify: HostUiService['notify']
	confirm: HostUiService['confirm']
	db: PluginUiDb<Name>
}>

export interface PluginUiCollection<
	Name extends string,
	Key extends PluginUiCollectionKey<Name>,
> {
	readonly name: Key
	useView(): SignalDbCollectionView<PluginUiCollectionItem<Name, Key>>
	useDocById(id: string): PluginUiCollectionItem<Name, Key> | undefined
	useDoc(
		selector: SignalDbSelector<PluginUiCollectionItem<Name, Key>>,
	): PluginUiCollectionItem<Name, Key> | undefined
	useList(
		spec?: SignalDbListSpec<PluginUiCollectionItem<Name, Key>>,
	): PluginUiCollectionItem<Name, Key>[]
	useCount(selector?: SignalDbSelector<PluginUiCollectionItem<Name, Key>>): number
	useLiveQuery<T>(
		query: (view: SignalDbCollectionView<PluginUiCollectionItem<Name, Key>>) => T,
		deps?: DependencyList,
	): T
}

export interface PluginUi<Name extends string> {
	use(): PluginUiApp<Name, PluginUiContext<Name>>
	useGlobal(): PluginUiApp<Name, GlobalExtensionContext>
}

function useExpectedPluginContext<Name extends string>(pluginName: Name): PluginUiContext<Name> {
	const context = usePluginExtensionContext()
	if (context.pluginName !== pluginName) {
		throw new Error(
			`[plugin-ui] helper for "${pluginName}" used under plugin "${context.pluginName}"`,
		)
	}
	return context as PluginUiContext<Name>
}

function useLocaleSnapshot(locale: ExtensionServices['locale']) {
	return useSyncExternalStore(
		(listener) => locale.subscribe(listener),
		() => `${locale.locale}\u0000${locale.fallbackLocale ?? ''}`,
		() => `${locale.locale}\u0000${locale.fallbackLocale ?? ''}`,
	)
}

function usePluginDb<Name extends string>(
	pluginName: Name,
	transport: RuntimeTransportClient,
): PluginUiDb<Name> {
	function useCollectionView<Key extends PluginUiCollectionKey<Name>>(collection: Key) {
		return useSignalDbCollectionState<PluginUiCollectionItem<Name, Key>>(
			transport,
			pluginName,
			String(collection),
		)
	}

	function useCollectionLiveQuery<Key extends PluginUiCollectionKey<Name>, T>(
		collection: Key,
		query: (view: SignalDbCollectionView<PluginUiCollectionItem<Name, Key>>) => T,
		deps: DependencyList = [],
	): T {
		const view = useCollectionView(collection)
		const stableDeps = useMemo(
			() => deps.map((dep) => stabilizeSignalDbValue(dep)),
			// `deps` comes from the caller; we intentionally normalize by structure.
			// eslint-disable-next-line react-hooks/exhaustive-deps
			[signalDbValueKey(deps)],
		)
		return useSignalDbQueryState(() => query(view), [view, stableDeps])
	}

	function useDocById<Key extends PluginUiCollectionKey<Name>>(collection: Key, id: string) {
		const stableId = useMemo(() => String(id), [id])
		return useDoc(collection, { id: stableId } as SignalDbSelector<PluginUiCollectionItem<Name, Key>>)
	}

	function useDoc<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<PluginUiCollectionItem<Name, Key>>,
	) {
		const stableSelector = useStableSignalDbSelector(selector)
		return useSignalDbDocState<PluginUiCollectionItem<Name, Key>>(
			transport,
			pluginName,
			String(collection),
			stableSelector,
		)
	}

	function useList<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		spec?: SignalDbListSpec<PluginUiCollectionItem<Name, Key>>,
	): PluginUiCollectionItem<Name, Key>[] {
		const stableSpec = useStableSignalDbListSpec(spec)
		return useCollectionLiveQuery(
			collection,
			(view) => view.find(stableSpec.where, toSignalDbFindOptions(stableSpec)),
			[stableSpec],
		)
	}

	function useCount<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<PluginUiCollectionItem<Name, Key>> = {} as SignalDbSelector<
			PluginUiCollectionItem<Name, Key>
		>,
	): number {
		const stableSelector = useStableSignalDbSelector(selector)
		return useCollectionLiveQuery(collection, (view) => view.count(stableSelector), [stableSelector])
	}

	function useLiveQuery<T>(query: () => T, deps?: DependencyList) {
		const stableDeps = useMemo(
			() => (deps ?? []).map((dep) => stabilizeSignalDbValue(dep)),
			// eslint-disable-next-line react-hooks/exhaustive-deps
			[signalDbValueKey(deps ?? [])],
		)
		return useSignalDbQueryState(query, stableDeps)
	}

	return useMemo(
		() => ({
			collection<Key extends PluginUiCollectionKey<Name>>(name: Key): PluginUiCollection<Name, Key> {
				return {
					name,
					useView: () => useCollectionView(name),
					useDocById: (id) => useDocById(name, id),
					useDoc: (selector) => useDoc(name, selector),
					useList: (spec) => useList(name, spec),
					useCount: (selector) => useCount(name, selector),
					useLiveQuery: (query, deps) => useCollectionLiveQuery(name, query, deps),
				}
			},
			useDocById,
			useDoc,
			useList,
			useCount,
			useLiveQuery,
		}),
		[pluginName, transport],
	)
}

function usePluginAppFromContext<Name extends string, Ctx extends ExtensionContext>(
	pluginName: Name,
	context: Ctx,
): PluginUiApp<Name, Ctx> {
	const services = context.services
	const transport = services.transport
	const localeSnapshot = useLocaleSnapshot(services.locale)
	const db = usePluginDb(pluginName, transport)
	const locale = services.locale.locale
	const fallbackLocale = services.locale.fallbackLocale
	const rpc = useMemo(
		() => ((transport.extensions as unknown) as Record<string, unknown>)[pluginName] as PluginUiRpc<Name>,
		[pluginName, transport],
	)
	const sse = useMemo(() => transport.sse.ns(pluginName) as SseNamespaceClient<Name>, [
		pluginName,
		transport,
	])

	return useMemo(
		() => ({
			pluginName,
			pathname: ('pluginName' in context ? context.pathname : null) as PluginUiApp<Name, Ctx>['pathname'],
			colorScheme: context.colorScheme,
			runningPlugins: context.runningPlugins,
			runningPluginsReady: context.runningPluginsReady,
			locale,
			fallbackLocale,
			setLocale: services.locale.setLocale.bind(services.locale),
			formatDate: services.locale.formatDate.bind(services.locale),
			formatNumber: services.locale.formatNumber.bind(services.locale),
			transport,
			rpc,
			sse,
			notify: services.ui.notify,
			confirm: services.ui.confirm,
			db,
		}),
		[context, db, fallbackLocale, locale, localeSnapshot, pluginName, rpc, services, sse, transport],
	)
}

export function pluginUi<const Name extends string>(pluginName: Name): PluginUi<Name> {
	function use(): PluginUiApp<Name, PluginUiContext<Name>> {
		const context = useExpectedPluginContext(pluginName)
		return usePluginAppFromContext(pluginName, context)
	}

	function useGlobal(): PluginUiApp<Name, GlobalExtensionContext> {
		const context = useGlobalExtensionContext()
		return usePluginAppFromContext(pluginName, context)
	}

	return {
		use,
		useGlobal,
	}
}

function useStableSignalDbSelector<T extends SignalDbItem>(
	selector: SignalDbSelector<T>,
): SignalDbSelector<T> {
	const normalized = useMemo(() => normalizeSignalDbSelector(selector), [signalDbValueKey(selector)])
	return normalized as SignalDbSelector<T>
}

function useStableSignalDbListSpec<T extends SignalDbItem>(
	spec?: SignalDbListSpec<T>,
): SignalDbListSpec<T> {
	return useMemo(() => normalizeSignalDbListSpec(spec), [signalDbValueKey(spec)])
}

function normalizeSignalDbSelector<T extends SignalDbItem>(
	selector?: SignalDbSelector<T>,
): SignalDbSelector<T> {
	if (!selector || typeof selector !== 'object') return {} as SignalDbSelector<T>
	return stabilizeSignalDbValue(selector) as SignalDbSelector<T>
}

function normalizeSignalDbListSpec<T extends SignalDbItem>(
	spec?: SignalDbListSpec<T>,
): SignalDbListSpec<T> {
	if (!spec || typeof spec !== 'object') return {} as SignalDbListSpec<T>
	const normalized: SignalDbListSpec<T> = {}
	if (spec.where && typeof spec.where === 'object') {
		normalized.where = normalizeSignalDbSelector(spec.where)
	}
	if (typeof spec.limit === 'number' && Number.isFinite(spec.limit)) {
		normalized.limit = Math.max(0, Math.trunc(spec.limit))
	}
	if (typeof spec.skip === 'number' && Number.isFinite(spec.skip)) {
		normalized.skip = Math.max(0, Math.trunc(spec.skip))
	}
	if (spec.sort && typeof spec.sort === 'object') {
		normalized.sort = stabilizeSignalDbValue(spec.sort) as SignalDbFindOptions<T>['sort']
	}
	return normalized
}

function toSignalDbFindOptions<T extends SignalDbItem>(
	spec: SignalDbListSpec<T>,
): SignalDbFindOptions<T> | undefined {
	const { where: _where, ...options } = spec
	return Object.keys(options).length > 0 ? options : undefined
}

function signalDbValueKey(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null) return 'null'
	const valueType = typeof value
	if (valueType === 'undefined') return 'undefined'
	if (valueType === 'string') return `string:${value}`
	if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
		return `${valueType}:${String(value)}`
	}
	if (valueType === 'symbol') return `symbol:${String(value)}`
	if (valueType === 'function') return `function:${(value as Function).name || 'anonymous'}`
	if (value instanceof Date) return `date:${value.toISOString()}`
	if (Array.isArray(value)) {
		return `array:[${value.map((item) => signalDbValueKey(item, seen)).join(',')}]`
	}
	if (valueType !== 'object') return `${valueType}:${String(value)}`
	if (seen.has(value as object)) return 'circular'
	seen.add(value as object)
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
	const result = `object:{${entries
		.map(([key, entryValue]) => `${key}:${signalDbValueKey(entryValue, seen)}`)
		.join(',')}}`
	seen.delete(value as object)
	return result
}

function stabilizeSignalDbValue<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value
	if (value instanceof Date) return new Date(value.getTime()) as T
	if (Array.isArray(value)) {
		return value.map((item) => stabilizeSignalDbValue(item)) as T
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entryValue]) => [key, stabilizeSignalDbValue(entryValue)]),
	) as T
}
