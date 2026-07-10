import { Tabs } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
	PANE_TABS_PROPS,
	PaneTabLabel,
	getPaneTabsRootClassName,
} from '../../../workbench/PaneTabs'
import { useWorkbenchTabIdentity } from '../../../workbench/context'
import { useResolvedWorkbenchTabState } from '../../../workbench/split'
import { setWorkbenchActiveTabState } from '../../../workbench/store'
import { useCurrentPathname } from '../../../router/useCurrentRoute'
import {
	getPluginScopedSearchCandidates,
	replacePluginDetailSearchParams,
	usePluginDetailSearch,
} from '../pluginDetailSearchState'

export type PluginWorkbenchView = {
	id: string
	label: string
	count?: number
	content: ReactNode
	hidden?: boolean
}

type PluginWorkbenchViewSearchKey = 'dock' | 'side'

function resolveVisibleViewId(
	value: unknown,
	views: PluginWorkbenchView[],
	pluginName?: string,
) {
	if (typeof value !== 'string') return undefined
	for (const candidate of getPluginScopedSearchCandidates(value, pluginName)) {
		if (views.some((view) => view.id === candidate)) return candidate
	}
	return undefined
}

function createViewIntentSignature(
	pathname: string,
	searchKey: PluginWorkbenchViewSearchKey,
	value: string,
) {
	return `${pathname}\n${searchKey}\n${value}`
}

function normalizeActiveView(value: unknown, views: PluginWorkbenchView[], fallbackId?: string) {
	if (views.length === 0) return ''
	if (typeof value === 'string' && views.some((view) => view.id === value)) return value
	if (fallbackId && views.some((view) => view.id === fallbackId)) return fallbackId
	return views[0]?.id ?? ''
}

export function PluginWorkbenchViewContainer({
	scope,
	label,
	eyebrow,
	title,
	subtitle,
	rightMeta,
	views,
	fallbackViewId,
	className,
	searchKey,
	searchPluginName,
	headerMode = 'stacked',
}: {
	scope: string
	label: string
	eyebrow?: ReactNode
	title?: ReactNode
	subtitle?: ReactNode
	rightMeta?: ReactNode
	views: PluginWorkbenchView[]
	fallbackViewId?: string
	className?: string
	searchKey?: PluginWorkbenchViewSearchKey
	searchPluginName?: string
	headerMode?: 'stacked' | 'inline'
}) {
	const { activeTabId } = useWorkbenchTabIdentity()
	const pathname = useCurrentPathname()
	const routeSearch = usePluginDetailSearch()
	const [localSearchValue, setLocalSearchValue] = useState<string | undefined>()
	const appliedRouteIntentSignatureRef = useRef<string | null>(null)
	const storedViewId = useResolvedWorkbenchTabState(scope, (value) =>
		typeof value === 'string' ? value : undefined,
	)
	const visibleViews = useMemo(() => views.filter((view) => !view.hidden), [views])
	const routeSearchValue = searchKey ? routeSearch[searchKey] : undefined
	const effectiveSearchValue = localSearchValue ?? routeSearchValue
	const routeViewId = useMemo(
		() => resolveVisibleViewId(effectiveSearchValue, visibleViews, searchPluginName),
		[effectiveSearchValue, searchPluginName, visibleViews],
	)
	const routeIntentSignature =
		searchKey && routeViewId && effectiveSearchValue
			? createViewIntentSignature(pathname, searchKey, effectiveSearchValue)
			: null
	const routeIntentPending = Boolean(
		routeIntentSignature &&
			appliedRouteIntentSignatureRef.current !== routeIntentSignature,
	)
	const hasHeading = Boolean(eyebrow || title || subtitle)
	const activeViewId = useMemo(
		() =>
			routeViewId && routeIntentPending
				? routeViewId
				: normalizeActiveView(storedViewId, visibleViews, fallbackViewId),
		[fallbackViewId, routeIntentPending, routeViewId, storedViewId, visibleViews],
	)

	useEffect(() => {
		setLocalSearchValue(undefined)
	}, [pathname, routeSearchValue])

	useEffect(() => {
		if (!routeViewId || !routeIntentSignature) return
		if (appliedRouteIntentSignatureRef.current === routeIntentSignature) return
		appliedRouteIntentSignatureRef.current = routeIntentSignature
		setWorkbenchActiveTabState(activeTabId, scope, routeViewId)
	}, [activeTabId, routeIntentSignature, routeViewId, scope])

	const selectView = useCallback(
		(viewId: string | null) => {
			if (!viewId || viewId === activeViewId) return
			setWorkbenchActiveTabState(activeTabId, scope, viewId)
			if (searchKey) {
				appliedRouteIntentSignatureRef.current = createViewIntentSignature(
					pathname,
					searchKey,
					viewId,
				)
				setLocalSearchValue(viewId)
				replacePluginDetailSearchParams({ [searchKey]: viewId })
			}
		},
		[activeTabId, activeViewId, pathname, scope, searchKey],
	)

	return (
		<Tabs
			{...PANE_TABS_PROPS}
			value={activeViewId}
			onChange={selectView}
			keepMounted
			className={`${getPaneTabsRootClassName('panel')} ${className ?? ''}`.trim()}
		>
			<div className="plx-pluginWorkbench__viewHeader" data-mode={headerMode}>
				{headerMode === 'inline' ? (
					<div className="plx-pluginWorkbench__tabsHeaderRow">
						<Tabs.List className="plx-paneTabs__list" aria-label={label}>
							{visibleViews.map((view) => (
								<Tabs.Tab key={view.id} value={view.id}>
									<PaneTabLabel
										label={view.label}
										badge={typeof view.count === 'number' ? view.count : undefined}
									/>
								</Tabs.Tab>
							))}
						</Tabs.List>
						{rightMeta ? <div className="plx-pluginWorkbench__headerAside">{rightMeta}</div> : null}
					</div>
				) : (
					<>
						{hasHeading || rightMeta ? (
							<div className="plx-pluginWorkbench__viewMeta">
								{hasHeading ? (
									<div className="plx-pluginWorkbench__viewTitle">
										{eyebrow ? <span className="plx-workbench__eyebrow">{eyebrow}</span> : null}
										{title ? <span className="plx-workbench__title">{title}</span> : null}
										{subtitle ? <span className="plx-workbench__subtitle">{subtitle}</span> : null}
									</div>
								) : (
									<div />
								)}
								{rightMeta ? (
									<div className="plx-pluginWorkbench__headerAside">{rightMeta}</div>
								) : null}
							</div>
						) : null}
						<Tabs.List className="plx-paneTabs__list" aria-label={label}>
							{visibleViews.map((view) => (
								<Tabs.Tab key={view.id} value={view.id}>
									<PaneTabLabel
										label={view.label}
										badge={typeof view.count === 'number' ? view.count : undefined}
									/>
								</Tabs.Tab>
							))}
						</Tabs.List>
					</>
				)}
			</div>

			<div className="plx-pluginWorkbench__viewBody">
				{visibleViews.map((view) => (
					<Tabs.Panel key={view.id} value={view.id} className="plx-paneTabs__panel">
						{view.content}
					</Tabs.Panel>
				))}
			</div>
		</Tabs>
	)
}
