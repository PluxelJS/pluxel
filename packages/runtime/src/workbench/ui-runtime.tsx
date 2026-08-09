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
	WorkbenchEventsOf,
	WorkbenchLiveQueryOf,
	WorkbenchLiveQueryResource,
	WorkbenchLayoutItem,
	WorkbenchPortContract,
	WorkbenchResourceMap,
	WorkbenchResourceRef,
	WorkbenchRpcClient,
	WorkbenchRpcOf,
} from './contracts'
import type { RuntimeTransportClient } from '../web/client'
import type { SseClientWithNamespaces } from '../web/sse'
import { createLiveQueryClient, type WorkbenchLiveQueryClient } from './ui-live-query'
import { createEventsClient, type WorkbenchEventsClient } from './ui-events'

export { createLiveQueryClient } from './ui-live-query'
export type { WorkbenchLiveQueryClient, WorkbenchLiveQueryResult } from './ui-live-query'
export type { WorkbenchEventConnectionState, WorkbenchEventsClient } from './ui-events'

export interface WorkbenchLocaleService {
	readonly locale: string
	readonly fallbackLocale?: string
	setLocale(locale: string, options?: { fallbackLocale?: string }): void
	subscribe(listener: () => void): () => void
	formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string
	formatNumber(value: number, options?: Intl.NumberFormatOptions): string
}

export type WorkbenchUiNotifyPayload = Readonly<{
	title?: string
	message?: string
	tone?: 'info' | 'success' | 'warning' | 'error'
}>

export type WorkbenchUiConfirmPayload = Readonly<{
	title?: string
	message: string
	confirmLabel?: string
	cancelLabel?: string
	tone?: 'default' | 'danger'
}>

/** @internal Host-owned capabilities injected into one remote View render. */
export type WorkbenchViewEnvironment = Readonly<{
	colorScheme: 'light' | 'dark'
	transport: RuntimeTransportClient
	locale: WorkbenchLocaleService
	notify(payload: WorkbenchUiNotifyPayload): void
	confirm(payload: WorkbenchUiConfirmPayload): Promise<boolean>
}>

export type WorkbenchOpenTabInput = Readonly<{
	/** Plugin-relative route path registered by the current Workbench target. */
	path: string
	/** Visible editor tab title. */
	title: string
	/** Optional secondary label shown with the tab. */
	meta?: string
}>

export type WorkbenchNavigation = Readonly<{
	/** Navigate to a registered plugin-relative shell route using the active Tab. */
	navigate(path: string): void
	/** Open or focus a business document identified by its normalized route path. */
	openTab(input: WorkbenchOpenTabInput): void
}>

export type WorkbenchViewRuntime = Readonly<{
	item: WorkbenchLayoutItem
	environment: WorkbenchViewEnvironment
	navigation?: WorkbenchNavigation
	routeParams: Readonly<Record<string, string>>
}>

const EMPTY_ROUTE_PARAMS = Object.freeze({})
const WorkbenchViewContext = createContext<WorkbenchViewRuntime | null>(null)

export function WorkbenchViewProvider({
	item,
	environment,
	navigation,
	routeParams = EMPTY_ROUTE_PARAMS,
	children,
}: {
	item: WorkbenchLayoutItem
	environment: WorkbenchViewEnvironment
	navigation?: WorkbenchNavigation
	routeParams?: Readonly<Record<string, string>>
	children: ReactNode
}) {
	const value = useMemo<WorkbenchViewRuntime>(
		() => ({ item, environment, navigation, routeParams }),
		[environment, item, navigation, routeParams],
	)
	return <WorkbenchViewContext.Provider value={value}>{children}</WorkbenchViewContext.Provider>
}

export function useWorkbenchView(): WorkbenchLayoutItem {
	return useWorkbenchViewRuntime().item
}

function useWorkbenchViewRuntime(): WorkbenchViewRuntime {
	const value = useContext(WorkbenchViewContext)
	if (!value) throw new Error('Workbench View must be rendered by its host runtime')
	return value
}

export type WorkbenchResourceClient<Resource> = Resource extends { kind: 'rpc' }
	? WorkbenchRpcClient<WorkbenchRpcOf<Resource>>
	: Resource extends WorkbenchLiveQueryResource<any, any>
		? WorkbenchLiveQueryClient<
				WorkbenchLiveQueryOf<Resource>['params'],
				WorkbenchLiveQueryOf<Resource>['row']
			>
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
	notify(payload: WorkbenchUiNotifyPayload): void
	confirm(payload: WorkbenchUiConfirmPayload): Promise<boolean>
	/** Shell navigation capability. `null` in standalone or non-navigable hosts. */
	navigation: WorkbenchNavigation | null
	routeParams: Readonly<Record<string, string>>
}>

export function useWorkbenchHost(): WorkbenchHost {
	const view = useWorkbenchViewRuntime()
	const { item } = view
	const { environment } = view
	const locale = useSyncExternalStore(
		(listener) => environment.locale.subscribe(listener),
		() => environment.locale.locale,
		() => environment.locale.locale,
	)
	return useMemo(
		() => ({
			ownerPluginId: item.ownerPluginId,
			targetPluginId: item.targetPluginId,
			colorScheme: environment.colorScheme,
			locale,
			notify: environment.notify,
			confirm: environment.confirm,
			navigation: view.navigation ?? null,
			routeParams: view.routeParams,
		}),
		[
			environment,
			item.ownerPluginId,
			item.targetPluginId,
			locale,
			view.navigation,
			view.routeParams,
		],
	)
}

export type WorkbenchViewComponent = ComponentType

export type WorkbenchUiModule = Readonly<{
	contractFingerprint: string
	views: Readonly<Record<string, WorkbenchViewComponent>>
	setup?: (ctx: {
		ownerPluginId: string
		locale: WorkbenchLocaleService
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
			return useGrantedResources<Contract['resources']>(item.model, contract.resources)
		},
		usePort<Port extends WorkbenchPortContract<any>>(port: Port) {
			const item = useWorkbenchView()
			if (!item.port || item.port.id !== port.id || item.port.version !== port.version) {
				throw new Error(
					`[workbench-ui] current View does not accept Port "${port.id}" v${port.version}`,
				)
			}
			return useGrantedResources<Port['resources']>(item.port.model, port.resources)
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
	contracts: Resources,
): WorkbenchResourceClients<Resources> {
	const view = useWorkbenchViewRuntime()
	const item = view.item
	const transport = view.environment.transport
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
			const contract = contracts[key]
			switch (ref.kind) {
				case 'rpc':
					resources[key] = transport.workbench.rpc(ref.grantId)
					break
				case 'liveQuery':
					resources[key] = createLiveQueryClient(
						transport,
						ref.grantId,
						contract as WorkbenchLiveQueryResource<any, any>,
					)
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
		// Capability safety comes from the opaque refs above, not from an observable
		// Proxy trap. React and developer tools reflect over hook values using keys such
		// as `$$typeof`; a normal frozen record must return undefined for those reads.
		return Object.freeze(resources) as WorkbenchResourceClients<Resources>
	}, [contracts, eventStreams, refs, transport])
}
