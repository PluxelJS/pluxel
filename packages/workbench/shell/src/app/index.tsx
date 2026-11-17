import { defaultParseSearch, type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { pluginNodeAddressEqual } from '@pluxel/core'
import { Actions, DockLocation, TabGroupNode, TabSetNode } from 'flexlayout-react'
import { Button, Text } from '@mantine/core'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
	createRuntimeManagementClient,
	type RuntimeClientBootstrap,
	RuntimeManagementClientProvider,
} from '../runtime'
import './bootstrap'
import '../styles/index.scss'
import { ProductProvider } from './product'
import { createAppRouter, readWorkbenchUiBasePath } from './router'
import { validatePluginDetailSearch } from './router/pluginDetailSearch'
import { WorkspaceSession } from './workbench/session'
import type { DestinationResolver } from '@worksplit/react'
import { WorkspaceSessionProvider } from './workbench/workspaceContext'
import { WorkspacePersistence, WorkspaceRestoreError } from './workbench/snapshot'
import { WorkbenchShell } from './workbench/WorkbenchShell'
import { WorkbenchSessionProvider, useWorkbenchTargetSnapshot } from '../workbench/runtime'
import { resolveWorkbenchDirectoryRoute } from '../workbench/route-directory'
import { parsePluginDetailHref, parseWorkbenchHref } from '../workbench/paths'
import { matchWorkbenchRoute } from '../workbench/routes'
import type { WorkbenchTargetSnapshot } from '../workbench/client-snapshot'
import { ManagementQueryProvider } from './managementQuery'
import { RuntimeUpdatesProvider } from './runtimeUpdates'
import { AppProviders } from './frames/AppProviders'
import { WorkbenchNavigationProvider } from './workbench/context'
import { GatePanel } from '../sessionGate'

export interface AppProps {
	bootstrap: Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
	workspace?: WorkspaceSession
	history?: RouterHistory
	standalone?: boolean
}

export function App(props: AppProps) {
	const [managementClient] = useState(() =>
		createRuntimeManagementClient(props.bootstrap.management),
	)
	return (
		<RuntimeManagementClientProvider client={managementClient}>
			<ManagementQueryProvider>
				<RuntimeUpdatesProvider>
					<WorkbenchSessionProvider session={props.bootstrap.workbench}>
						<ProductProvider client={managementClient}>
							<AppProviders>
								<SessionSurface {...props} />
							</AppProviders>
						</ProductProvider>
					</WorkbenchSessionProvider>
				</RuntimeUpdatesProvider>
			</ManagementQueryProvider>
		</RuntimeManagementClientProvider>
	)
}

/** Classify against the committed publication before creating either browser-history owner. */
function SessionSurface({ bootstrap, workspace: supplied, history, standalone }: AppProps) {
	const snapshot = useWorkbenchTargetSnapshot(null)
	const [entry] = useState(() => ({
		basepath: supplied?.basepath ?? readWorkbenchUiBasePath(),
		href: history?.location.href ?? location.pathname + location.search + location.hash,
	}))
	const [surface, setSurface] = useState<
		| { workspace: WorkspaceSession }
		| { router: ReturnType<typeof createAppRouter> }
		| { error: Error }
	>()
	const surfaceRef = useRef<typeof surface>(undefined)
	const [owner] = useState(() => ({ mounts: 0 }))
	const publication = useRef(snapshot)
	publication.current = snapshot
	useEffect(() => {
		if (surfaceRef.current || (!snapshot.layout && !standalone)) return
		const pathname = new URL(entry.href, location.origin).pathname
		const path =
			entry.basepath !== '/' &&
			(pathname === entry.basepath || pathname.startsWith(`${entry.basepath}/`))
				? pathname.slice(entry.basepath.length) || '/'
				: pathname
		const frame =
			parseWorkbenchHref(path)?.frame ??
			resolveWorkbenchDirectoryRoute(snapshot.directory, path)?.frame
		try {
			surfaceRef.current =
				standalone || frame === 'standalone'
					? { router: createAppRouter({ history, uiBasePath: entry.basepath }) }
					: {
							workspace:
								supplied ??
								new WorkspaceSession({ initialShortcuts: snapshot.layout?.initialShortcuts }),
						}
		} catch (cause) {
			surfaceRef.current = { error: cause instanceof Error ? cause : new Error(String(cause)) }
		}
		setSurface(surfaceRef.current)
	}, [
		bootstrap,
		entry,
		history,
		snapshot.directory,
		snapshot.layout,
		standalone,
		supplied,
		surface,
	])
	const workspace = surface && 'workspace' in surface ? surface.workspace : undefined
	useEffect(() => {
		if (!surface || 'error' in surface) return
		owner.mounts++
		if (workspace) {
			workspace.resolveTitle = (href) =>
				defaultDocumentTitle(publication.current, new URL(href, location.origin), entry.basepath)
			void workspace.start(entry.href, !history).catch((cause: unknown) => workspace.report(cause))
		}
		return () => {
			owner.mounts--
			queueMicrotask(() => {
				if (owner.mounts !== 0) return
				if (workspace) void workspace.dispose()
				else if ('router' in surface && !history) surface.router.history.destroy()
			})
		}
	}, [entry.basepath, entry.href, history, owner, surface, workspace])
	const navigation = useMemo(() => {
		const open = (
			to: string,
			newInstance = false,
			presentation?: { title: string; meta?: string; afterDocumentId?: string },
		) => {
			const url = new URL(to, location.origin)
			const basepath = entry.basepath
			const path =
				basepath !== '/' && (url.pathname === basepath || url.pathname.startsWith(`${basepath}/`))
					? url.pathname.slice(basepath.length) || '/'
					: url.pathname
			const publicHref = `${basepath === '/' ? '' : basepath}${path}${url.search}${url.hash}`
			const frame =
				parseWorkbenchHref(path)?.frame ??
				resolveWorkbenchDirectoryRoute(publication.current.directory, path)?.frame
			if (!workspace || frame === 'standalone' || url.origin !== location.origin) {
				const href = url.origin === location.origin ? publicHref : url.href
				if (workspace) void workspace.leave(href).catch((cause: unknown) => workspace.report(cause))
				else location.assign(href)
				return
			}
			const active = workspace.workbench.getActiveDocument()
			if (!newInstance && active) {
				const navigate = workspace.documents.get(active.id)?.navigate
				if (!navigate) {
					workspace.report(new Error('当前标签页正在准备，请稍后重试'))
					return
				}
				void navigate({
					to: path,
					search: defaultParseSearch(url.search),
					hash: url.hash.slice(1),
				}).catch((cause: unknown) => workspace.report(cause))
				return
			}
			const anchor = presentation?.afterDocumentId
				? workspace.workbench.getDocument(presentation.afterDocumentId)
				: undefined
			const destination: DestinationResolver | undefined = anchor
				? ({ model }) => {
						const node = model.getNodeById(anchor.id)
						if (node !== anchor.node) return null
						const sibling = node.getParent() instanceof TabGroupNode ? node.getParent()! : node
						const container = sibling.getParent()
						return container instanceof TabSetNode
							? {
									target: container.getId(),
									location: DockLocation.CENTER,
									index: container.getChildren().indexOf(sibling) + 1,
								}
							: null
					}
				: undefined
			void workspace.workbench
				.open(
					{ to: path, search: defaultParseSearch(url.search), hash: url.hash.slice(1) },
					{
						reuse: newInstance ? 'new' : 'preserve',
						source: (anchor ?? active)?.handle,
						destination,
					},
				)
				.then(async (result) => {
					workspace.check(result)
					if (
						result.status !== 'applied' ||
						!presentation ||
						!workspace.workbench.getDocument(result.value.document.id)
					)
						return
					return workspace.check(
						await workspace.workbench.dispatch(
							Actions.updateNodeAttributes(result.value.document.id, {
								...(!presentation.afterDocumentId
									? {
											config: {
												...result.value.document.node.getConfig(),
												pluxelTitle: {
													href: result.value.document.href,
													value: presentation.title,
												},
											},
										}
									: {}),
								helpText: presentation.meta,
							}),
						),
					)
				})
				.catch((cause: unknown) => workspace.report(cause))
		}
		return {
			navigate: (path: string) => open(path),
			openTab: (input: { path: string; title: string; meta?: string; afterDocumentId?: string }) =>
				open(input.path, true, input),
		}
	}, [entry.basepath, workspace])
	if (!surface)
		return (
			<GatePanel title="正在准备 Workbench 入口">
				<Text c={snapshot.error ? 'red' : 'dimmed'}>
					{snapshot.error?.message ?? '读取已发布的页面…'}
				</Text>
				{snapshot.error && <Button onClick={() => location.reload()}>重试</Button>}
			</GatePanel>
		)
	if ('error' in surface)
		return (
			<GatePanel title="工作区无法恢复">
				<Text c="red">{surface.error.message}</Text>
				<Button onClick={() => location.reload()}>保留现场并重试</Button>
				{surface.error instanceof WorkspaceRestoreError && <RestoreLayout error={surface.error} />}
			</GatePanel>
		)
	return (
		<WorkbenchNavigationProvider value={navigation}>
			{'router' in surface ? (
				<RouterProvider router={surface.router} />
			) : (
				<WorkspaceSessionProvider value={surface.workspace}>
					<WorkspacePersistence />
					<WorkbenchShell />
				</WorkspaceSessionProvider>
			)}
		</WorkbenchNavigationProvider>
	)
}

/** Derive only a new document's initial native name from its committed publication. */
function defaultDocumentTitle(snapshot: WorkbenchTargetSnapshot, url: URL, basepath: string) {
	const pathname =
		basepath !== '/' && (url.pathname === basepath || url.pathname.startsWith(`${basepath}/`))
			? url.pathname.slice(basepath.length) || '/'
			: url.pathname
	const detail = parsePluginDetailHref(pathname)
	if (detail) {
		const entries = snapshot.layout?.entries ?? []
		const key = validatePluginDetailSearch(defaultParseSearch(url.search)).entry
		const entry = entries.find(
			(candidate) =>
				pluginNodeAddressEqual(candidate.target.node, detail.target) &&
				candidate.descriptor.key === key &&
				candidate.placement.kind === 'tab',
		)
		if (entry?.placement.kind === 'tab') return entry.placement.label ?? entry.descriptor.key
		return entries.find((candidate) => pluginNodeAddressEqual(candidate.target.node, detail.target))
			?.target.displayName
	}
	const canonical = parseWorkbenchHref(pathname)
	if (canonical) {
		const route = snapshot.directory.routes.find(
			(candidate) =>
				pluginNodeAddressEqual(candidate.entry.target.node, canonical.target) &&
				matchWorkbenchRoute(candidate.compiled, canonical.path) !== null,
		)
		return route?.entry.placement.kind === 'route' ? route.entry.placement.title : undefined
	}
	const route = resolveWorkbenchDirectoryRoute(snapshot.directory, pathname)
	return route?.entry.placement.kind === 'route' ? route.entry.placement.title : undefined
}

function RestoreLayout({ error }: { error: WorkspaceRestoreError }) {
	const failure = useSyncExternalStore(error.storage.subscribe, error.storage.getSnapshot)
	return (
		<>
			{failure && <Text c="red">{failure}</Text>}
			<Button
				color="red"
				variant="light"
				onClick={() => {
					if (error.storage.reset()) location.reload()
				}}
			>
				删除保存的布局并重新打开
			</Button>
		</>
	)
}
