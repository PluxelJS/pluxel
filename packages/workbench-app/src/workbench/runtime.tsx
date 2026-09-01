import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import {
	openWorkbenchView,
	type WorkbenchFederatedLayoutEntry,
	type WorkbenchLayoutEntry,
	type WorkbenchOpenedPageHandle,
	type WorkbenchSessionApi,
	type WorkbenchStandardPageLayoutEntry,
	type WorkbenchStandardPagePlanV1,
} from '@pluxel/runtime/workbench/client'
import {
	createWorkbenchViewHost,
	openFederatedWorkbenchView,
	type FederatedWorkbenchView,
	type WorkbenchViewHostHandle,
	type WorkbenchConfirmInput,
	type WorkbenchNotificationInput,
	type WorkbenchNavigation,
	type WorkbenchPaneLayoutRenderer,
	type WorkbenchPaneLayoutRendererProps,
} from '@pluxel/runtime/workbench/federation'
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import { InlineNotice } from '../components'
import { StandardPageRenderer } from '../app/workbench/StandardPageRenderer'
import {
	useActiveWorkbenchTabId,
	useOptionalWorkspaceNavigation,
	useWorkbenchViewState as useHostWorkbenchViewState,
	useWorkspaceController,
} from '../app/workbench/context'
import {
	HostRemotePaneLayout,
	RemotePaneLayoutStateProvider,
} from '../app/workbench/RemotePaneLayout'
import { WorkbenchErrorBoundary } from './ErrorBoundary'
import {
	WorkbenchLayoutRuntime,
	type WorkbenchResolvedRoute,
	type WorkbenchTargetId,
} from './client'
import { buildWorkbenchHref, normalizeWorkbenchPath } from './paths'
import { toWorkbenchError } from './errors'

export type WorkbenchBrowserHost = Readonly<{
	locale: string
	colorScheme: 'light' | 'dark'
	notify(input: WorkbenchNotificationInput): void
	confirm(input: WorkbenchConfirmInput): Promise<boolean>
	runningPluginKeys: ReadonlySet<string>
	runningPluginsReady: boolean
}>

type WorkbenchRuntimeContextValue = WorkbenchBrowserHost & {
	session: RpcStub<WorkbenchSessionApi>
	runtime: WorkbenchLayoutRuntime
}

type WorkbenchTargetContextValue = Readonly<{
	target: PluginNodeAddress
	pathname: string
	snapshot: ReturnType<WorkbenchLayoutRuntime['getSnapshot']>
}>

type WorkbenchFederatedEntryActivation = {
	readonly input: Readonly<{
		activeTabId: ReturnType<typeof useActiveWorkbenchTabId>
		entry: WorkbenchFederatedLayoutEntry
		frame: 'shell' | 'standalone'
		hostNavigation: WorkbenchNavigation | undefined
		layoutRevision: number
		location: string | undefined
		paneLayoutRenderer: WorkbenchPaneLayoutRenderer
		params: Readonly<Record<string, string>>
		session: RpcStub<WorkbenchSessionApi>
		workspace: ReturnType<typeof useWorkspaceController>
	}>
	mounts: number
	started: boolean
	active: boolean
	appearanceDirty: boolean
	host?: WorkbenchViewHostHandle
	opened?: FederatedWorkbenchView
}

type WorkbenchPageEntryActivation = {
	readonly input: Readonly<{
		entry: WorkbenchStandardPageLayoutEntry
		layoutRevision: number
		location: string | undefined
		session: RpcStub<WorkbenchSessionApi>
	}>
	mounts: number
	started: boolean
	active: boolean
	opened?: WorkbenchOpenedPageHandle
}

const WorkbenchSessionContext = createContext<RpcStub<WorkbenchSessionApi> | null>(null)
const WorkbenchRuntimeContext = createContext<WorkbenchRuntimeContextValue | null>(null)
const WorkbenchTargetContext = createContext<WorkbenchTargetContextValue | null>(null)

export function WorkbenchSessionProvider({
	session,
	children,
}: {
	session: RpcStub<WorkbenchSessionApi>
	children: ReactNode
}) {
	return (
		<WorkbenchSessionContext.Provider value={session}>{children}</WorkbenchSessionContext.Provider>
	)
}

export function useWorkbenchSession(): RpcStub<WorkbenchSessionApi> {
	const session = useContext(WorkbenchSessionContext)
	if (!session) throw new Error('WorkbenchSessionProvider required')
	return session
}

export function WorkbenchRuntimeProvider({
	host,
	children,
}: {
	host: WorkbenchBrowserHost
	children: ReactNode
}) {
	const session = useWorkbenchSession()
	const [runtime] = useState(() => new WorkbenchLayoutRuntime(session))
	const [ownership] = useState(() => ({ mounts: 0 }))
	useEffect(() => {
		ownership.mounts += 1
		return () => {
			ownership.mounts -= 1
			queueMicrotask(() => {
				if (ownership.mounts === 0) runtime[Symbol.dispose]()
			})
		}
	}, [ownership, runtime])
	const value = useMemo<WorkbenchRuntimeContextValue>(
		() => ({ ...host, session, runtime }),
		[host, runtime, session],
	)
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

export function useWorkbenchTargetSnapshot(target: WorkbenchTargetId) {
	const { runtime } = useWorkbenchRuntime()
	useEffect(() => runtime.retain(target), [runtime, target])
	return useSyncExternalStore(
		(listener) => runtime.subscribe(target, listener),
		() => runtime.getSnapshot(target),
		() => runtime.getSnapshot(target),
	)
}

export function useWorkbenchNavigationRoutes(): readonly WorkbenchLayoutEntry[] {
	return useWorkbenchTargetSnapshot(null).navigationRoutes
}

export function useWorkbenchTabs(options: { render?: boolean } = {}) {
	const target = useWorkbenchTarget().target
	const snapshot = useWorkbenchTargetSnapshot(target)
	const entries = snapshot.tabs
	const nodes = useMemo(
		() =>
			options.render === false
				? EMPTY_NODES
				: entries.map((entry) => (
						<WorkbenchEntryView
							key={workbenchEntryKey(entry)}
							entry={entry}
							frame="shell"
							layoutRevision={snapshot.layout?.revision ?? 0}
							params={EMPTY_ROUTE_PARAMS}
						/>
					)),
		[entries, options.render, snapshot.layout?.revision],
	)
	return { entries, nodes, snapshot, hasEntries: entries.length > 0 }
}

const EMPTY_NODES: ReactNode[] = []
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
	route,
	snapshot,
}: {
	route: WorkbenchResolvedRoute
	snapshot: ReturnType<WorkbenchLayoutRuntime['getSnapshot']>
}) {
	return (
		<WorkbenchEntryView
			entry={route.entry}
			frame={route.frame}
			layoutRevision={snapshot.layout?.revision ?? 0}
			location={route.location}
			params={route.params}
		/>
	)
}

type WorkbenchEntryViewProps = Readonly<{
	entry: WorkbenchLayoutEntry
	frame: 'shell' | 'standalone'
	layoutRevision: number
	location?: string
	params: Readonly<Record<string, string>>
}>

export function WorkbenchEntryView(props: WorkbenchEntryViewProps) {
	const { entry, layoutRevision, location } = props
	if ('standardPageRef' in entry) {
		return (
			<WorkbenchStandardPageEntryView
				key={`${workbenchEntryKey(entry)}:${layoutRevision}:${location ?? ''}`}
				entry={entry}
				layoutRevision={layoutRevision}
				location={location}
			/>
		)
	}
	return <FederatedWorkbenchEntryView {...props} entry={entry} />
}

function FederatedWorkbenchEntryView({
	entry,
	frame,
	layoutRevision,
	location,
	params,
}: Omit<WorkbenchEntryViewProps, 'entry'> & { entry: WorkbenchFederatedLayoutEntry }) {
	const { session, locale, colorScheme, notify, confirm } = useWorkbenchRuntime()
	const navigation = useOptionalWorkspaceNavigation()
	const workspace = useWorkspaceController()
	const activeTabId = useActiveWorkbenchTabId()
	const viewState = useHostWorkbenchViewState(workbenchEntryKey(entry), frame)
	const domRef = useRef<HTMLDivElement | null>(null)
	const [error, setError] = useState<Error | null>(null)
	const [opening, setOpening] = useState(true)
	const notifyRef = useRef(notify)
	const confirmRef = useRef(confirm)
	const localeRef = useRef(locale)
	const colorSchemeRef = useRef(colorScheme)
	notifyRef.current = notify
	confirmRef.current = confirm
	localeRef.current = locale
	colorSchemeRef.current = colorScheme

	const resolveShellPath = useCallback(
		(inputPath: string, operation: 'navigate' | 'openDocument') => {
			const path = normalizeWorkbenchPath(inputPath)
			if (!path) throw new Error(`[workbench-app] ${operation} path must target a Plugin route`)
			return path
		},
		[],
	)
	const hostNavigation = useMemo(
		() =>
			frame === 'shell' && navigation
				? {
						navigate(inputPath: string) {
							const path = resolveShellPath(inputPath, 'navigate')
							navigation.navigate(buildWorkbenchHref(entry.target.node, path, 'shell'))
						},
						openDocument(input: { path: string; title: string; meta?: string }) {
							const path = resolveShellPath(input.path, 'openDocument')
							navigation.openTab({
								path: buildWorkbenchHref(entry.target.node, path, 'shell'),
								title: input.title,
								...(input.meta === undefined ? {} : { meta: input.meta }),
							})
						},
					}
				: undefined,
		[entry.target.node, frame, navigation, resolveShellPath],
	)
	const paneLayoutRenderer = useMemo(() => createPaneLayoutRenderer(viewState), [viewState])
	const activation = useMemo(
		() =>
			createFederatedEntryActivation({
				activeTabId,
				entry,
				frame,
				hostNavigation,
				layoutRevision,
				location,
				paneLayoutRenderer,
				params,
				session,
				workspace,
			}),
		[
			activeTabId,
			entry,
			frame,
			hostNavigation,
			layoutRevision,
			location,
			paneLayoutRenderer,
			params,
			session,
			workspace,
		],
	)

	useEffect(() => {
		const dom = domRef.current
		if (!dom) return undefined
		const {
			activeTabId: openingTabId,
			entry: openingEntry,
			frame: openingFrame,
			hostNavigation: openingNavigation,
			layoutRevision: openingRevision,
			location: openingLocation,
			paneLayoutRenderer: openingPaneLayout,
			params: openingParams,
			session: openingSession,
			workspace: openingWorkspace,
		} = activation.input
		activation.mounts += 1
		if (activation.started) {
			return () => releaseFederatedActivation(activation)
		}
		activation.started = true
		setOpening(true)
		setError(null)
		const originalTab = openingTabId
			? openingWorkspace.state.uiState.tabs.find((tab) => tab.instanceId === openingTabId)
			: undefined
		const host = createWorkbenchViewHost({
			locale: localeRef.current,
			colorScheme: colorSchemeRef.current,
			notify: (input) => notifyRef.current(input),
			confirm: (input) => confirmRef.current(input),
			...(openingNavigation ? { navigation: openingNavigation } : {}),
			...(openingFrame === 'shell' && openingTabId
				? {
						document: {
							params: openingParams,
							setDirty: (dirty: boolean) => openingWorkspace.setTabDirty(openingTabId, dirty),
							setTitle: (input: { title: string; meta?: string }) =>
								openingWorkspace.setTabPresentation(openingTabId, input),
							reset: () => {
								if (originalTab) {
									openingWorkspace.setTabPresentation(openingTabId, originalTab)
								}
							},
						},
					}
				: {}),
		})
		activation.host = host
		void openFederatedWorkbenchView({
			session: openingSession,
			entry: openingEntry,
			layoutRevision: openingRevision,
			...(openingLocation === undefined ? {} : { location: openingLocation }),
			dom,
			host,
			paneLayoutRenderer: openingPaneLayout,
		}).then(
			(result): undefined => {
				if (result.ok === false) {
					if (activation.active) {
						setOpening(false)
						setError(new Error(`Workbench View could not open: ${result.code}`))
					}
					return undefined
				}
				activation.opened = result.view
				if (!activation.active) {
					activation.opened[Symbol.dispose]()
					return undefined
				}
				if (activation.appearanceDirty) {
					activation.appearanceDirty = false
					void activation.opened.update().catch((cause: unknown) => {
						if (!activation.active) return
						setError(toWorkbenchError(cause, 'Workbench View could not be updated'))
					})
				}
				setOpening(false)
				return undefined
			},
			(openError: unknown): undefined => {
				if (!activation.active) return undefined
				setOpening(false)
				setError(toWorkbenchError(openError, 'Workbench View could not be opened'))
				return undefined
			},
		)
		return () => releaseFederatedActivation(activation)
	}, [activation])

	useEffect(() => {
		const host = activation.host
		if (!host?.active) return
		if (host.facade.locale === locale && host.facade.colorScheme === colorScheme) return
		host.updateAppearance({ locale, colorScheme })
		const opened = activation.opened
		if (!opened?.active) {
			activation.appearanceDirty = true
			return
		}
		void opened.update().catch((cause: unknown) => {
			if (!activation.active) return
			setError(toWorkbenchError(cause, 'Workbench View could not be updated'))
		})
	}, [activation, colorScheme, locale])

	return (
		<WorkbenchErrorBoundary
			pluginName={entry.renderer.definition.exportName}
			contributionId={entry.descriptor.key}
			point={entry.placement.kind}
		>
			<div ref={domRef} style={{ display: 'contents' }} />
			{opening ? <InlineNotice title="Workbench View">正在打开…</InlineNotice> : null}
			{error ? <InlineNotice title="Workbench View 打开失败">{error.message}</InlineNotice> : null}
		</WorkbenchErrorBoundary>
	)
}

export function WorkbenchStandardPageEntryView({
	entry,
	layoutRevision,
	location,
}: {
	entry: WorkbenchStandardPageLayoutEntry
	layoutRevision: number
	location?: string
}) {
	const { session } = useWorkbenchRuntime()
	const [plan, setPlan] = useState<WorkbenchStandardPagePlanV1 | null>(null)
	const [error, setError] = useState<Error | null>(null)
	const [opening, setOpening] = useState(true)
	const activation = useMemo(
		() => createPageEntryActivation({ entry, layoutRevision, location, session }),
		[entry, layoutRevision, location, session],
	)

	useEffect(() => {
		const {
			entry: openingEntry,
			layoutRevision: openingRevision,
			location: openingLocation,
			session: openingSession,
		} = activation.input
		activation.mounts += 1
		if (activation.started) return () => releasePageActivation(activation)
		activation.started = true
		setOpening(true)
		setError(null)
		setPlan(null)
		void openWorkbenchView(openingSession, openingEntry, {
			layoutRevision: openingRevision,
			...(openingLocation === undefined ? {} : { location: openingLocation }),
		}).then(
			(result): undefined => {
				if (result.ok === false) {
					if (activation.active) {
						setOpening(false)
						setError(new Error(`Standard Page could not open: ${result.code}`))
					}
					return undefined
				}
				activation.opened = result.handle
				if (!activation.active) {
					activation.opened[Symbol.dispose]()
					return undefined
				}
				setPlan(activation.opened.plan)
				setOpening(false)
				return undefined
			},
			(openError: unknown): undefined => {
				if (!activation.active) return undefined
				setOpening(false)
				setError(toWorkbenchError(openError, 'Standard Page could not be opened'))
				return undefined
			},
		)
		return () => releasePageActivation(activation)
	}, [activation])

	return (
		<WorkbenchErrorBoundary
			pluginName={entry.target.node.definition.exportName}
			contributionId={entry.descriptor.key}
			point={entry.placement.kind}
		>
			{plan ? <StandardPageRenderer plan={plan} /> : null}
			{opening ? <InlineNotice title="Standard Page">正在打开…</InlineNotice> : null}
			{error ? <InlineNotice title="Standard Page 打开失败">{error.message}</InlineNotice> : null}
		</WorkbenchErrorBoundary>
	)
}

function createPaneLayoutRenderer(
	state: ReturnType<typeof useHostWorkbenchViewState>,
): WorkbenchPaneLayoutRenderer {
	return function WorkbenchPaneLayout(props: WorkbenchPaneLayoutRendererProps) {
		return (
			<RemotePaneLayoutStateProvider state={state}>
				<HostRemotePaneLayout {...props} />
			</RemotePaneLayoutStateProvider>
		)
	}
}

function createFederatedEntryActivation(
	input: WorkbenchFederatedEntryActivation['input'],
): WorkbenchFederatedEntryActivation {
	return {
		input,
		mounts: 0,
		started: false,
		active: true,
		appearanceDirty: false,
	}
}

function releaseFederatedActivation(activation: WorkbenchFederatedEntryActivation): void {
	activation.mounts -= 1
	queueMicrotask(() => {
		if (activation.mounts !== 0 || !activation.active) return
		activation.active = false
		if (activation.opened) activation.opened[Symbol.dispose]()
		else activation.host?.[Symbol.dispose]()
	})
}

function createPageEntryActivation(
	input: WorkbenchPageEntryActivation['input'],
): WorkbenchPageEntryActivation {
	return { input, mounts: 0, started: false, active: true }
}

function releasePageActivation(activation: WorkbenchPageEntryActivation): void {
	activation.mounts -= 1
	queueMicrotask(() => {
		if (activation.mounts !== 0 || !activation.active) return
		activation.active = false
		activation.opened?.[Symbol.dispose]()
	})
}

function workbenchEntryKey(entry: WorkbenchLayoutEntry): string {
	return `${pluginNodeIndexKey(entry.target.node)}:${entry.descriptor.kind}:${entry.descriptor.key}`
}
