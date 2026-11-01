import { useRuntimeManagementClient } from '../runtime'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { RpcStub } from 'capnweb'
import type { WorkbenchContent } from '@worksplit/react'
import {
	openWorkbenchEntry,
	type WorkbenchFederatedLayoutEntry,
	type WorkbenchLayoutEntry,
	type WorkbenchOpenedContentHandle,
	type WorkbenchReadyFederatedLayoutEntry,
	type WorkbenchSessionApi,
	type WorkbenchContentLayoutEntry,
	type WorkbenchContentPlan,
	type WorkbenchUnavailableFederatedLayoutEntry,
} from '@pluxel/workbench/client'
import {
	createWorkbenchViewHost,
	openFederatedWorkbenchView,
	type FederatedWorkbenchView,
	type WorkbenchViewHostHandle,
	type WorkbenchConfirmInput,
	type WorkbenchNotificationInput,
} from '@pluxel/workbench/federation'
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
import { WorkbenchContentRenderer } from '../app/workbench/WorkbenchContentRenderer'
import { WorkbenchContentController } from '../app/workbench/WorkbenchContentController'
import type { WorkbenchContentInteraction } from '../app/workbench/WorkbenchContentSlots'
import { useOptionalWorkspaceNavigation } from '../app/workbench/context'
import { useOptionalWorkbenchDocument } from '../app/workbench/document'
import { useOptionalWorkspaceSession } from '../app/workbench/workspaceContext'
import { Actions } from 'flexlayout-react'
import { useRouter } from '@tanstack/react-router'
import { WorkbenchRendererError } from '@pluxel/workbench/react'
import { notifyAndRecord } from '../app/notifications/notifyBridge'
import { WorkbenchErrorBoundary } from './ErrorBoundary'
import {
	WorkbenchLayoutRuntime,
	type WorkbenchResolvedRoute,
	type WorkbenchTargetId,
} from './client'
import { normalizeWorkbenchPath, parseWorkbenchHref } from './paths'
import { getWorkbenchDirectoryHref, resolveWorkbenchDirectoryRoute } from './route-directory'
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

type WorkbenchFederatedEntryActivation = {
	signal?: AbortSignal
	appearanceDirty: boolean
	host?: WorkbenchViewHostHandle
	opened?: FederatedWorkbenchView
}

type WorkbenchContentEntryActivation = {
	opened?: WorkbenchOpenedContentHandle
	controller?: WorkbenchContentController
}

const WorkbenchSessionContext = createContext<RpcStub<WorkbenchSessionApi> | null>(null)
const WorkbenchRuntimeContext = createContext<WorkbenchRuntimeContextValue | null>(null)

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

export function useWorkbenchRuntime(): WorkbenchRuntimeContextValue {
	const value = useContext(WorkbenchRuntimeContext)
	if (!value) throw new Error('WorkbenchRuntimeProvider required')
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

export function useWorkbenchRouteDirectory() {
	return useWorkbenchTargetSnapshot(null).directory
}

export function useWorkbenchTabs(target: PluginNodeAddress) {
	const snapshot = useWorkbenchTargetSnapshot(target)
	const entries = snapshot.tabs
	return { entries, snapshot }
}

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
	content?: WorkbenchContent
	entry: WorkbenchLayoutEntry
	frame: 'shell' | 'standalone'
	layoutRevision: number
	location?: string
	params: Readonly<Record<string, string>>
}>

export function WorkbenchEntryView(props: WorkbenchEntryViewProps) {
	const { entry, layoutRevision, location } = props
	if ('contentRef' in entry) {
		return (
			<WorkbenchContentEntryView
				key={`${workbenchEntryKey(entry)}:${layoutRevision}:${location ?? ''}`}
				content={props.content}
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
	content,
}: Omit<WorkbenchEntryViewProps, 'entry'> & { entry: WorkbenchFederatedLayoutEntry }) {
	if (isUnavailableFederatedLayoutEntry(entry)) {
		return <UnavailableFederatedWorkbenchEntryView entry={entry} />
	}
	if (!isReadyFederatedLayoutEntry(entry)) {
		throw new Error('[workbench/shell] federated entry has no renderer availability')
	}
	return (
		<ReadyFederatedWorkbenchEntryView
			entry={entry}
			frame={frame}
			layoutRevision={layoutRevision}
			location={location}
			params={params}
			content={content}
		/>
	)
}

function UnavailableFederatedWorkbenchEntryView({
	entry,
}: {
	entry: WorkbenchUnavailableFederatedLayoutEntry
}) {
	const unavailable = entry.federatedViewUnavailable
	const failed = unavailable.reason === 'failed'
	return (
		<WorkbenchErrorBoundary
			pluginName={entry.renderer.definition.exportName}
			contributionId={entry.descriptor.key}
			point={entry.placement.kind}
		>
			<InlineNotice
				title={failed ? 'Workbench View 构建失败' : 'Workbench View 正在构建'}
				tone={failed ? 'error' : 'muted'}
			>
				{failed
					? unavailable.message
					: '对应界面产物正在后台构建，完成后 Workbench 会话会自动刷新。'}
			</InlineNotice>
		</WorkbenchErrorBoundary>
	)
}

function ReadyFederatedWorkbenchEntryView({
	entry,
	frame,
	layoutRevision,
	location,
	params,
	content: suppliedContent,
}: Omit<WorkbenchEntryViewProps, 'entry'> & { entry: WorkbenchReadyFederatedLayoutEntry }) {
	const management = useRuntimeManagementClient()
	const { session, locale, colorScheme, notify, confirm } = useWorkbenchRuntime()
	const navigation = useOptionalWorkspaceNavigation()
	const directory = useWorkbenchRouteDirectory()
	const workspace = useOptionalWorkspaceSession()
	const router = useRouter({ warn: false })
	const document = useOptionalWorkbenchDocument()
	const contentOwner = suppliedContent ?? document?.content
	const activationRef = useRef<WorkbenchFederatedEntryActivation | null>(null)
	const activeTabId = document?.id ?? null
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
			if (!path) throw new Error(`[workbench/shell] ${operation} path must target a Plugin route`)
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
							const href = getWorkbenchDirectoryHref(directory, entry.target.node, path)
							const url = new URL(href, window.location.origin)
							const destinationFrame =
								parseWorkbenchHref(url.pathname)?.frame ??
								resolveWorkbenchDirectoryRoute(directory, url.pathname)?.frame
							if (router && destinationFrame !== 'standalone')
								void router
									.navigate({
										to: url.pathname,
										search: Object.fromEntries(url.searchParams),
										hash: url.hash.slice(1),
									})
									.catch((cause: unknown) => workspace?.report(cause))
							else navigation.navigate(href)
						},
						openDocument(input: { path: string; title: string; meta?: string }) {
							const path = resolveShellPath(input.path, 'openDocument')
							navigation.openTab({
								path: getWorkbenchDirectoryHref(directory, entry.target.node, path),
								title: input.title,
								...(input.meta === undefined ? {} : { meta: input.meta }),
							})
						},
					}
				: undefined,
		[directory, entry.target.node, frame, navigation, resolveShellPath, router, workspace],
	)
	const activationInput = useMemo(
		() => ({
			activeTabId,
			entry,
			frame,
			hostNavigation,
			layoutRevision,
			location,
			document: document?.state,
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
			document,
			params,
			session,
			workspace,
		],
	)

	useEffect(() => {
		const dom = domRef.current
		if (!dom) return undefined
		const activation: WorkbenchFederatedEntryActivation = { appearanceDirty: false }
		activationRef.current = activation
		const {
			activeTabId: openingTabId,
			entry: openingEntry,
			frame: openingFrame,
			hostNavigation: openingNavigation,
			layoutRevision: openingRevision,
			location: openingLocation,
			document: openingDocument,
			params: openingParams,
			session: openingSession,
			workspace: openingWorkspace,
		} = activationInput
		const release = () => {
			if (activationRef.current === activation) activationRef.current = null
			disposeFederatedActivation(activation)
		}
		const open = async (signal: AbortSignal, releaseLate: () => void) => {
			activation.signal = signal
			setOpening(true)
			setError(null)
			const originalTab = openingTabId
				? openingWorkspace?.workbench.getDocument(openingTabId)
				: undefined
			let originalPresentation: { title: string; helpText?: string } | undefined
			const host = createWorkbenchViewHost({
				management,
				locale: localeRef.current,
				colorScheme: colorSchemeRef.current,
				notify: (input) => notifyRef.current(input),
				confirm: (input) => confirmRef.current(input),
				...(openingNavigation ? { navigation: openingNavigation } : {}),
				...(openingFrame === 'shell' && openingTabId && openingWorkspace
					? {
							document: {
								params: openingParams,
								setDirty: (dirty: boolean) => {
									if (openingDocument) openingDocument.remoteDirty = dirty
									openingWorkspace.notifyContentState()
								},
								setTitle: (input: { title: string; meta?: string }) => {
									// The caller's openDocument presentation can commit after this View
									// starts opening. Capture the native rollback value at the first override.
									const currentTab = openingWorkspace.workbench.getDocument(openingTabId)
									if (currentTab && !originalPresentation) {
										const layout = openingWorkspace.workbench.getLayout()
										let helpText: string | undefined
										const visit = (node: {
											id?: string
											helpText?: string
											children?: unknown[]
										}) => {
											if (node.id === openingTabId) helpText = node.helpText
											for (const child of node.children ?? [])
												visit(child as Parameters<typeof visit>[0])
										}
										visit(layout.layout)
										for (const border of layout.borders ?? []) visit(border)
										originalPresentation = { title: currentTab.title, helpText }
									}
									void openingWorkspace.workbench
										.dispatch(
											Actions.updateNodeAttributes(openingTabId, {
												name: input.title,
												helpText: input.meta,
											}),
										)
										.then((result) => {
											openingWorkspace.check(result)
											return result
										})
										.catch((cause: unknown) => openingWorkspace.report(cause))
								},
								reset: () => {
									const currentTab = openingWorkspace.workbench.getDocument(openingTabId)
									const previous = originalTab
										? new URL(originalTab.href, window.location.origin)
										: undefined
									const current = currentTab
										? new URL(currentTab.href, window.location.origin)
										: undefined
									if (
										originalPresentation &&
										previous &&
										current &&
										previous.pathname === current.pathname &&
										previous.searchParams.get('entry') === current.searchParams.get('entry')
									) {
										void openingWorkspace.workbench
											.dispatch(
												Actions.updateNodeAttributes(openingTabId, {
													name: originalPresentation.title,
													helpText: originalPresentation.helpText,
												}),
											)
											.then((result) => {
												openingWorkspace.check(result)
												return result
											})
											.catch((cause: unknown) => openingWorkspace.report(cause))
									}
									if (openingDocument) openingDocument.remoteDirty = false
									openingWorkspace.notifyContentState()
								},
							},
						}
					: {}),
			})
			activation.host = host
			try {
				const result = await openFederatedWorkbenchView({
					session: openingSession,
					entry: openingEntry,
					layoutRevision: openingRevision,
					...(openingLocation === undefined ? {} : { location: openingLocation }),
					dom,
					host,
				})
				if (result.ok === false) {
					if (!signal.aborted) {
						setOpening(false)
						setError(
							new Error(
								`Workbench View could not open: ${result.code}${result.diagnosticId ? ` (diagnostic ${result.diagnosticId})` : ''}`,
							),
						)
					}
					return
				}
				activation.opened = result.view
				if (signal.aborted) {
					releaseLate()
					return
				}
				if (activation.appearanceDirty) {
					activation.appearanceDirty = false
					await activation.opened.update()
				}
				if (!signal.aborted) setOpening(false)
			} catch (cause) {
				if (signal.aborted) {
					// The SDK closes an in-flight View when this effect releases its host.
					if (cause instanceof WorkbenchRendererError && cause.code === 'WORKBENCH_RENDERER_CLOSED')
						return
					throw cause
				}
				setOpening(false)
				setError(toWorkbenchError(cause, 'Workbench View could not be opened'))
			}
		}
		if (contentOwner) {
			return contentOwner.effect(({ signal, defer }) => {
				defer(release)
				return open(signal, () => defer(release))
			})
		}
		// Standalone routes have no Worksplit content; React owns this SDK activation.
		const lifetime = new AbortController()
		void open(lifetime.signal, release).catch(reportActivationCleanup)
		return () => {
			lifetime.abort()
			try {
				release()
			} catch (cause) {
				reportActivationCleanup(cause)
			}
		}
	}, [activationInput, contentOwner, management])

	useEffect(() => {
		const activation = activationRef.current
		if (!activation || activation.signal?.aborted) return
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
			if (activation.signal?.aborted) {
				if (cause instanceof WorkbenchRendererError && cause.code === 'WORKBENCH_RENDERER_CLOSED')
					return
				reportActivationCleanup(cause)
				return
			}
			setError(toWorkbenchError(cause, 'Workbench View could not be updated'))
		})
	}, [colorScheme, locale])

	return (
		<WorkbenchErrorBoundary
			pluginName={entry.renderer.definition.exportName}
			contributionId={entry.descriptor.key}
			point={entry.placement.kind}
		>
			<div
				ref={domRef}
				style={{
					display: 'grid',
					flex: 1,
					gridTemplateColumns: 'minmax(0, 1fr)',
					gridTemplateRows: 'minmax(0, 1fr)',
					minWidth: 0,
					minHeight: 0,
					height: '100%',
					width: '100%',
				}}
			/>
			{opening ? <InlineNotice title="Workbench View">正在打开…</InlineNotice> : null}
			{error ? <InlineNotice title="Workbench View 打开失败">{error.message}</InlineNotice> : null}
		</WorkbenchErrorBoundary>
	)
}

export function WorkbenchContentEntryView({
	entry,
	layoutRevision,
	location,
	content: suppliedContent,
}: {
	entry: WorkbenchContentLayoutEntry
	layoutRevision: number
	location?: string
	content?: WorkbenchContent
}) {
	const { confirm, notify, session } = useWorkbenchRuntime()
	const document = useOptionalWorkbenchDocument()
	const contentOwner = suppliedContent ?? document?.content
	const confirmRef = useRef(confirm)
	const notifyRef = useRef(notify)
	confirmRef.current = confirm
	notifyRef.current = notify
	const [content, setContent] = useState<Readonly<{
		plan: WorkbenchContentPlan
		interaction: WorkbenchContentInteraction | null
	}> | null>(null)
	const [error, setError] = useState<Error | null>(null)
	const [opening, setOpening] = useState(true)

	useEffect(() => {
		const activation: WorkbenchContentEntryActivation = {}
		const release = () => disposeContentActivation(activation)
		const open = async (signal: AbortSignal, releaseLate: () => void) => {
			setOpening(true)
			setError(null)
			setContent(null)
			try {
				const result = await openWorkbenchEntry(session, entry, {
					layoutRevision,
					...(location === undefined ? {} : { location }),
				})
				if (result.ok === false) {
					if (!signal.aborted) {
						setOpening(false)
						setError(
							new Error(
								`Workbench Content could not open: ${result.code}${result.diagnosticId ? ` (diagnostic ${result.diagnosticId})` : ''}`,
							),
						)
					}
					return
				}
				activation.opened = result.handle
				if (signal.aborted) {
					releaseLate()
					return
				}
				const opened = result.handle
				if (opened.mode === 'interactive' && opened.presentation) {
					const controller = new WorkbenchContentController(opened)
					activation.controller = controller
					controller.start()
					setContent({
						plan: opened.plan,
						interaction: {
							presentation: opened.presentation,
							controller,
							confirm: (input) => confirmRef.current(input),
							notify: (input) => notifyRef.current(input),
						},
					})
				} else {
					setContent({ plan: opened.plan, interaction: null })
				}
				setOpening(false)
			} catch (cause) {
				if (signal.aborted) throw cause
				setOpening(false)
				setError(toWorkbenchError(cause, 'Workbench Content could not be opened'))
			}
		}
		if (contentOwner) {
			return contentOwner.effect(({ signal, defer }) => {
				defer(release)
				return open(signal, () => defer(release))
			})
		}
		// Standalone routes have no Worksplit content; React owns this SDK activation.
		const lifetime = new AbortController()
		void open(lifetime.signal, release).catch(reportActivationCleanup)
		return () => {
			lifetime.abort()
			try {
				release()
			} catch (cause) {
				reportActivationCleanup(cause)
			}
		}
	}, [contentOwner, entry, layoutRevision, location, session])

	return (
		<WorkbenchErrorBoundary
			pluginName={entry.target.node.definition.exportName}
			contributionId={entry.descriptor.key}
			point={entry.placement.kind}
		>
			{content ? (
				<WorkbenchContentRenderer interaction={content.interaction} plan={content.plan} />
			) : null}
			{opening ? <InlineNotice title="Workbench Content">正在打开…</InlineNotice> : null}
			{error ? (
				<InlineNotice title="Workbench Content 打开失败">{error.message}</InlineNotice>
			) : null}
		</WorkbenchErrorBoundary>
	)
}

function reportActivationCleanup(cause: unknown) {
	notifyAndRecord({
		title: '文档资源释放失败',
		message: cause instanceof Error ? cause.message : String(cause),
		color: 'red',
	})
}

function disposeFederatedActivation(activation: WorkbenchFederatedEntryActivation): void {
	const opened = activation.opened
	const host = activation.host
	activation.opened = undefined
	activation.host = undefined
	// The SDK maintains Bridge → host facade → RPC handle ordering, including failures.
	if (opened) opened[Symbol.dispose]()
	else host?.[Symbol.dispose]()
}

function disposeContentActivation(activation: WorkbenchContentEntryActivation): void {
	const controller = activation.controller
	const opened = activation.opened
	activation.controller = undefined
	activation.opened = undefined
	const errors: unknown[] = []
	try {
		controller?.[Symbol.dispose]()
	} catch (cause) {
		errors.push(cause)
	}
	try {
		opened?.[Symbol.dispose]()
	} catch (cause) {
		errors.push(cause)
	}
	if (errors.length > 0) throw new AggregateError(errors, 'Workbench Content 释放失败')
}

function workbenchEntryKey(entry: WorkbenchLayoutEntry): string {
	return `${pluginNodeIndexKey(entry.target.node)}:${entry.descriptor.kind}:${entry.descriptor.key}`
}

function isUnavailableFederatedLayoutEntry(
	entry: WorkbenchFederatedLayoutEntry,
): entry is WorkbenchUnavailableFederatedLayoutEntry {
	return entry.federatedViewUnavailable !== undefined
}

function isReadyFederatedLayoutEntry(
	entry: WorkbenchFederatedLayoutEntry,
): entry is WorkbenchReadyFederatedLayoutEntry {
	return entry.federatedViewRef !== undefined
}
