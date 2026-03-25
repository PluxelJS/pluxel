import type { DependencyList } from 'react'
import { useMemo } from 'react'
import type {
	ExtensionContext,
	ExtensionServices,
	GlobalExtensionContext,
	PluginExtensionContext,
} from './ui-contracts'
import { useExtensionContext } from './ui-contracts'
import type { RuntimeTransportClient } from '../client'
import type { ExtensionUiRpcMap, ExtensionUiSignalDbMap } from '../protocol'
import type { SignalDbItem, SignalDbSelector } from './signaldb-contracts'
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
 * Unified browser-side client surface for one plugin namespace.
 *
 * - `rpc` / `sse`: primary plugin interaction channels
 * - `notify` / `confirm` / `locale`: host-provided deterministic UI affordances
 * - `transport`: low-level transport escape hatch when needed
 */
export type PluginUiClient<
	Name extends string,
	Ctx extends ExtensionContext = ExtensionContext,
> = Readonly<{
	context: Ctx
	transport: RuntimeTransportClient
	rpc: PluginUiRpc<Name>
	sse: SseNamespaceClient<Name>
	notify: HostUiService['notify']
	confirm: HostUiService['confirm']
	locale: ExtensionServices['locale']
}>

export interface PluginUi<Name extends string> {
	use(): PluginUiClient<Name>
	use(kind: 'global'): PluginUiClient<Name, GlobalExtensionContext>
	use(kind: 'plugin'): PluginUiClient<Name, PluginUiContext<Name>>
	useSignalDbQuery<T>(query: () => T, deps?: DependencyList): T
	useCollection<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
	): SignalDbCollectionView<PluginUiCollectionItem<Name, Key>>
	useDoc<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<PluginUiCollectionItem<Name, Key>>,
	): PluginUiCollectionItem<Name, Key> | undefined
}

function usePluginClientFromContext<Name extends string, Ctx extends ExtensionContext>(
	pluginName: Name,
	context: Ctx,
): PluginUiClient<Name, Ctx> {
	const services = context.services
	const transport = services.transport

	return useMemo(
		() => ({
			context,
			transport,
			rpc: ((transport.extensions as unknown) as Record<string, unknown>)[pluginName] as PluginUiRpc<Name>,
			sse: transport.sse.ns(pluginName) as SseNamespaceClient<Name>,
			notify: services.ui.notify,
			confirm: services.ui.confirm,
			locale: services.locale,
		}),
		[context, pluginName, services, transport],
	)
}

function useExpectedPluginContext<Name extends string>(pluginName: Name): PluginUiContext<Name> {
	const context = useExtensionContext('plugin')
	if (context.pluginName !== pluginName) {
		throw new Error(
			`[plugin-ui] helper for "${pluginName}" used under plugin "${context.pluginName}"`,
		)
	}
	return context as PluginUiContext<Name>
}

export function createPluginUi<const Name extends string>(pluginName: Name): PluginUi<Name> {
	function use(): PluginUiClient<Name>
	function use(kind: 'global'): PluginUiClient<Name, GlobalExtensionContext>
	function use(kind: 'plugin'): PluginUiClient<Name, PluginUiContext<Name>>
	function use(kind?: 'global' | 'plugin') {
		if (kind === 'global') {
			const context = useExtensionContext('global')
			return usePluginClientFromContext(pluginName, context)
		}
		if (kind === 'plugin') {
			const context = useExpectedPluginContext(pluginName)
			return usePluginClientFromContext(pluginName, context)
		}
		const context = useExtensionContext()
		return usePluginClientFromContext(pluginName, context)
	}

	function useCollection<Key extends PluginUiCollectionKey<Name>>(collection: Key) {
		const client = use()
		return useSignalDbCollectionState<PluginUiCollectionItem<Name, Key>>(
			client.transport,
			pluginName,
			String(collection),
		)
	}

	function useDoc<Key extends PluginUiCollectionKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<PluginUiCollectionItem<Name, Key>>,
	) {
		const client = use()
		return useSignalDbDocState<PluginUiCollectionItem<Name, Key>>(
			client.transport,
			pluginName,
			String(collection),
			selector,
		)
	}

	function useSignalDbQuery<T>(query: () => T, deps?: DependencyList) {
		return useSignalDbQueryState(query, deps)
	}

	return {
		use,
		useSignalDbQuery,
		useCollection,
		useDoc,
	}
}
