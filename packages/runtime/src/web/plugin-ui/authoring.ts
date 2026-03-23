import { useMemo } from 'react'
import type {
	ExtensionContext,
	ExtensionServices,
	GlobalExtensionContext,
	I18nService,
	PluginExtensionContext,
} from './ui-contracts'
import { useExtensionContext } from './ui-contracts'
import type { HmrUiRpcMap, HmrUiSignalDbMap, HmrWebClient, SseNamespaceClient } from './ui-runtime'
import type { SignalDbItem, SignalDbSelector } from './signaldb-contracts'
import {
	type SignalDbCollectionView,
	useSignalDbCollectionState,
	useSignalDbDocState,
} from './signaldb-runtime'

type HostUiService = NonNullable<ExtensionServices['ui']>

export type NamespaceUiRpc<Name extends string> = Name extends keyof HmrUiRpcMap
	? HmrUiRpcMap[Name]
	: never

type NamespaceUiSignalDb<Name extends string> = Name extends keyof HmrUiSignalDbMap
	? HmrUiSignalDbMap[Name]
	: Record<string, SignalDbItem>

type NamespaceUiSignalDbKey<Name extends string> = Extract<keyof NamespaceUiSignalDb<Name>, string>

type NamespaceUiSignalDbItem<
	Name extends string,
	Key extends NamespaceUiSignalDbKey<Name>,
> = NamespaceUiSignalDb<Name>[Key] extends SignalDbItem ? NamespaceUiSignalDb<Name>[Key] : SignalDbItem

export type PluginUiContext<Name extends string> = PluginExtensionContext & { pluginName: Name }

export type NamespaceUiRuntime<
	Name extends string,
	Ctx extends ExtensionContext = ExtensionContext,
> = Readonly<{
	namespace: Name
	context: Ctx
	services: ExtensionServices
	hmr: HmrWebClient
	rpc: NamespaceUiRpc<Name>
	sse: SseNamespaceClient<Name>
	sseClient: HmrWebClient['sse']
	notify: HostUiService['notify'] | undefined
	confirm: HostUiService['confirm'] | undefined
	i18n: I18nService | undefined
}>

export type PluginUiRuntime<Name extends string> = Omit<
	NamespaceUiRuntime<Name, PluginUiContext<Name>>,
	'namespace'
> & {
	pluginName: Name
}

export interface PluginUiHelpers<Name extends string> {
	readonly namespace: Name
	useContext(): ExtensionContext
	useGlobalContext(): GlobalExtensionContext
	usePluginContext(): PluginUiContext<Name>
	useRuntime(): NamespaceUiRuntime<Name>
	useGlobalRuntime(): NamespaceUiRuntime<Name, GlobalExtensionContext>
	usePluginRuntime(): PluginUiRuntime<Name>
	useServices(): ExtensionServices
	useHmr(): HmrWebClient
	useRpc(): NamespaceUiRpc<Name>
	useSse(): SseNamespaceClient<Name>
	useSignalDbCollection<Key extends NamespaceUiSignalDbKey<Name>>(
		collection: Key,
	): SignalDbCollectionView<NamespaceUiSignalDbItem<Name, Key>>
	useSignalDbDoc<Key extends NamespaceUiSignalDbKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<NamespaceUiSignalDbItem<Name, Key>>,
	): NamespaceUiSignalDbItem<Name, Key> | undefined
}

function useNamespaceRuntimeFromContext<Name extends string, Ctx extends ExtensionContext>(
	namespace: Name,
	context: Ctx,
): NamespaceUiRuntime<Name, Ctx> {
	const services = context.services
	const hmr = services.hmr

	return useMemo(
		() => ({
			namespace,
			context,
			services,
			hmr,
			rpc: ((hmr.ui as unknown) as Record<string, unknown>)[namespace] as NamespaceUiRpc<Name>,
			sse: hmr.sse.ns(namespace) as SseNamespaceClient<Name>,
			sseClient: hmr.sse,
			notify: services.ui?.notify,
			confirm: services.ui?.confirm,
			i18n: services.i18n,
		}),
		[context, hmr, namespace, services],
	)
}

function useExpectedPluginContext<Name extends string>(namespace: Name): PluginUiContext<Name> {
	const context = useExtensionContext('plugin')
	if (context.pluginName !== namespace) {
		throw new Error(
			`[plugin-ui] helper for "${namespace}" used under plugin "${context.pluginName}"`,
		)
	}
	return context as PluginUiContext<Name>
}

export function createPluginUiHelpers<const Name extends string>(namespace: Name): PluginUiHelpers<Name> {
	function useContext() {
		return useExtensionContext()
	}

	function useGlobalContext() {
		return useExtensionContext('global')
	}

	function usePluginContext() {
		return useExpectedPluginContext(namespace)
	}

	function useRuntime() {
		const context = useContext()
		return useNamespaceRuntimeFromContext(namespace, context)
	}

	function useGlobalRuntime() {
		const context = useGlobalContext()
		return useNamespaceRuntimeFromContext(namespace, context)
	}

	function usePluginRuntime() {
		const context = usePluginContext()
		const runtime = useNamespaceRuntimeFromContext(namespace, context)
		return useMemo(
			() => ({
				...runtime,
				pluginName: namespace,
			}),
			[namespace, runtime],
		)
	}

	function useServices() {
		return useContext().services
	}

	function useHmr() {
		return useServices().hmr
	}

	function useRpc() {
		return useRuntime().rpc
	}

	function useSse() {
		return useRuntime().sse
	}

	function useSignalDbCollection<Key extends NamespaceUiSignalDbKey<Name>>(collection: Key) {
		const hmr = useHmr()
		return useSignalDbCollectionState<NamespaceUiSignalDbItem<Name, Key>>(
			hmr,
			namespace,
			String(collection),
		)
	}

	function useSignalDbDoc<Key extends NamespaceUiSignalDbKey<Name>>(
		collection: Key,
		selector: SignalDbSelector<NamespaceUiSignalDbItem<Name, Key>>,
	) {
		const hmr = useHmr()
		return useSignalDbDocState<NamespaceUiSignalDbItem<Name, Key>>(
			hmr,
			namespace,
			String(collection),
			selector,
		)
	}

	return {
		namespace,
		useContext,
		useGlobalContext,
		usePluginContext,
		useRuntime,
		useGlobalRuntime,
		usePluginRuntime,
		useServices,
		useHmr,
		useRpc,
		useSse,
		useSignalDbCollection,
		useSignalDbDoc,
	}
}
