import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import type {
	WorkbenchLayoutItem,
	WorkbenchPlacement,
	WorkbenchViewMeta,
} from '@pluxel/runtime/workbench'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import {
	WorkbenchViewProvider,
	type WorkbenchViewEnvironment,
} from '@pluxel/runtime/workbench/ui/internal'
import { InlineNotice } from '../components'
import { BuiltinDoc } from './builtin/Doc'
import { WorkbenchErrorBoundary } from './ErrorBoundary'
import { buildWorkbenchHref, normalizeWorkbenchPath } from './paths'
import {
	useOptionalWorkspaceNavigation,
	useWorkbenchViewState as useHostWorkbenchViewState,
} from '../app/workbench/context'
import {
	HostRemotePaneLayout,
	RemotePaneLayoutStateProvider,
} from '../app/workbench/RemotePaneLayout'
import {
	WorkbenchClientRuntime,
	type WorkbenchResolvedRoute,
	type WorkbenchTargetId,
	type WorkbenchTargetSnapshot,
} from './client'

export type WorkbenchBrowserHost = Readonly<{
	environment: WorkbenchViewEnvironment
	runningPluginKeys: ReadonlySet<string>
	runningPluginsReady: boolean
}>

type WorkbenchRuntimeContextValue = WorkbenchBrowserHost & {
	runtime: WorkbenchClientRuntime
}

type WorkbenchTargetContextValue = Readonly<{
	target: PluginNodeAddress
	pathname: string
	snapshot: WorkbenchTargetSnapshot
}>

const WorkbenchRuntimeContext = createContext<WorkbenchRuntimeContextValue | null>(null)
const WorkbenchTargetContext = createContext<WorkbenchTargetContextValue | null>(null)

export function WorkbenchRuntimeProvider({
	host,
	active = true,
	children,
}: {
	host: WorkbenchBrowserHost
	active?: boolean
	children: ReactNode
}) {
	const [runtime] = useState(
		() => new WorkbenchClientRuntime(host.environment.transport, host.environment.locale),
	)
	useEffect(() => (active ? runtime.retain(null) : undefined), [active, runtime])
	const value = useMemo<WorkbenchRuntimeContextValue>(() => ({ ...host, runtime }), [host, runtime])
	return (
		<WorkbenchRuntimeContext.Provider value={value}>{children}</WorkbenchRuntimeContext.Provider>
	)
}

export function WorkbenchTargetProvider({
	target,
	pathname,
	children,
}: {
	target: PluginNodeAddress
	pathname: string
	children: ReactNode
}) {
	const snapshot = useWorkbenchTargetSnapshot(target)
	const value = useMemo(() => ({ target, pathname, snapshot }), [pathname, snapshot, target])
	return <WorkbenchTargetContext.Provider value={value}>{children}</WorkbenchTargetContext.Provider>
}

export function useWorkbenchRuntime(): WorkbenchRuntimeContextValue {
	const value = useContext(WorkbenchRuntimeContext)
	if (!value) throw new Error('WorkbenchRuntimeProvider required')
	return value
}

export function useWorkbenchTarget(): WorkbenchTargetContextValue {
	const value = useContext(WorkbenchTargetContext)
	if (!value) throw new Error('WorkbenchTargetProvider required')
	return value
}

export function useWorkbenchTargetSnapshot(target: WorkbenchTargetId): WorkbenchTargetSnapshot {
	const { runtime } = useWorkbenchRuntime()
	useEffect(() => runtime.retain(target), [runtime, target])
	return useSyncExternalStore(
		(listener) => runtime.subscribe(target, listener),
		() => runtime.getSnapshot(target),
		() => runtime.getSnapshot(target),
	)
}

export function useWorkbenchArtifactState(owner: PluginNodeAddress) {
	const { runtime } = useWorkbenchRuntime()
	useWorkbenchTargetSnapshot(null)
	return runtime.artifactState(owner)
}

export function useWorkbenchNavigationRoutes(): readonly WorkbenchLayoutItem[] {
	return useWorkbenchTargetSnapshot(null).navigationRoutes
}

export function useWorkbenchSurface(
	placement: WorkbenchPlacement,
	options: { target?: WorkbenchTargetId; render?: boolean } = {},
) {
	const targetContext = useContext(WorkbenchTargetContext)
	const target = options.target === undefined ? (targetContext?.target ?? null) : options.target
	const snapshot = useWorkbenchTargetSnapshot(target)
	const items = snapshot.surfaces.get(placement) ?? EMPTY_ITEMS
	const nodes = useMemo(
		() =>
			options.render === false
				? EMPTY_NODES
				: items.map((item) => (
						<WorkbenchItem
							key={`${target === null ? '$global' : pluginNodeIndexKey(target)}:${item.id}`}
							frame="shell"
							item={item}
							snapshot={snapshot}
						/>
					)),
		[items, options.render, snapshot, target],
	)
	return { items, nodes, snapshot, hasItems: items.length > 0 }
}

const EMPTY_NODES: ReactNode[] = []
const EMPTY_ITEMS: readonly WorkbenchLayoutItem[] = Object.freeze([])
const EMPTY_ROUTE_PARAMS = Object.freeze({})

export function useResolvedWorkbenchRoute(target: PluginNodeAddress, path: string) {
	const { runtime } = useWorkbenchRuntime()
	const snapshot = useWorkbenchTargetSnapshot(target)
	return useMemo(
		() => ({ snapshot, route: runtime.resolveRoute(target, path) }),
		[path, runtime, snapshot, target],
	)
}

export function WorkbenchRoute({
	target,
	route,
}: {
	target: PluginNodeAddress
	route: WorkbenchResolvedRoute
}) {
	const snapshot = useWorkbenchTargetSnapshot(target)
	return (
		<WorkbenchItem
			frame={route.frame}
			item={route.item}
			routeParams={route.params}
			snapshot={snapshot}
		/>
	)
}

function WorkbenchItem({
	frame,
	item,
	snapshot,
	routeParams = EMPTY_ROUTE_PARAMS,
}: {
	frame: 'shell' | 'standalone'
	item: WorkbenchLayoutItem
	snapshot: WorkbenchTargetSnapshot
	routeParams?: Readonly<Record<string, string>>
}) {
	if (item.view.kind === 'builtin') return <WorkbenchBuiltinView item={item} />
	return (
		<WorkbenchRemoteView frame={frame} item={item} routeParams={routeParams} snapshot={snapshot} />
	)
}

function WorkbenchBuiltinView({ item }: { item: WorkbenchLayoutItem }) {
	const { environment } = useWorkbenchRuntime()
	if (item.view.kind !== 'builtin') return null
	const props = item.view.props as { title?: string; description?: string; content?: unknown }
	if (!Array.isArray(props.content)) {
		return <InlineNotice title="Invalid workbench document">content is required</InlineNotice>
	}
	return (
		<WorkbenchViewProvider item={item} environment={environment}>
			<BuiltinDoc
				id={item.id}
				pluginName={item.target.displayName}
				title={props.title}
				description={props.description}
				content={props.content as never}
			/>
		</WorkbenchViewProvider>
	)
}

function WorkbenchRemoteView({
	frame,
	item,
	snapshot,
	routeParams,
}: {
	frame: 'shell' | 'standalone'
	item: WorkbenchLayoutItem
	snapshot: WorkbenchTargetSnapshot
	routeParams: Readonly<Record<string, string>>
}) {
	const { runtime, environment } = useWorkbenchRuntime()
	const navigation = useOptionalWorkspaceNavigation()
	const viewState = useHostWorkbenchViewState(workbenchViewStateIdentity(item), frame)
	const resolveShellPath = useCallback(
		(inputPath: string, operation: 'navigate' | 'openTab') => {
			const path = normalizeWorkbenchPath(inputPath)
			if (!path) throw new Error(`[workbench-ui] ${operation}.path must target a plugin route`)
			const resolved = runtime.resolveRoute(item.target.address, path)
			if (!resolved) throw new Error(`[workbench-ui] ${operation} route is not registered: ${path}`)
			if (resolved.frame !== 'shell') {
				throw new Error(`[workbench-ui] ${operation} only supports shell routes`)
			}
			return path
		},
		[item.target.address, runtime],
	)
	const navigate = useCallback(
		(inputPath: string) => {
			if (!navigation) throw new Error('[workbench-ui] current frame does not support navigation')
			const path = resolveShellPath(inputPath, 'navigate')
			navigation.navigate(buildWorkbenchHref(item.target.address, path, 'shell'))
		},
		[item.target.address, navigation, resolveShellPath],
	)
	const openTab = useCallback(
		(input: { path: string; title: string; meta?: string }) => {
			if (!navigation) throw new Error('[workbench-ui] current frame does not support native tabs')
			const path = resolveShellPath(input.path, 'openTab')
			const title = input.title.trim()
			if (!title) throw new Error('[workbench-ui] openTab.title is required')
			navigation.openTab({
				path: buildWorkbenchHref(item.target.address, path, 'shell'),
				title,
				meta: input.meta?.trim() || undefined,
			})
		},
		[item.target.address, navigation, resolveShellPath],
	)
	const hostNavigation = useMemo(
		() => (navigation ? { navigate, openTab } : undefined),
		[navigate, navigation, openTab],
	)
	const View = runtime.view(snapshot.target, item)
	if (!View) {
		return (
			<InlineNotice title="Workbench Contract mismatch">
				{`${item.owner.displayName}:${item.view.kind === 'remote' ? item.view.export : item.viewId}`}
			</InlineNotice>
		)
	}
	return (
		<WorkbenchErrorBoundary
			pluginName={item.owner.displayName}
			contributionId={item.id}
			point={item.placement}
		>
			<RemotePaneLayoutStateProvider state={viewState}>
				<WorkbenchViewProvider
					item={item}
					environment={environment}
					frame={frame}
					navigation={frame === 'shell' ? hostNavigation : undefined}
					paneLayoutRenderer={HostRemotePaneLayout}
					routeParams={routeParams}
					state={viewState}
				>
					<View />
				</WorkbenchViewProvider>
			</RemotePaneLayoutStateProvider>
		</WorkbenchErrorBoundary>
	)
}

function workbenchViewStateIdentity(item: WorkbenchLayoutItem): string {
	const route = item.meta?.route?.path ?? ''
	return [
		pluginNodeIndexKey(item.owner.address),
		pluginNodeIndexKey(item.target.address),
		item.viewId,
		item.placement,
		route,
	]
		.map(encodeURIComponent)
		.join(':')
}

export function workbenchItemMeta(item: WorkbenchLayoutItem): WorkbenchViewMeta {
	return item.meta ?? Object.freeze({})
}
