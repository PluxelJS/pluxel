import { Tabs } from '@mantine/core'
import type { ReactNode } from 'react'
import { useCallback, useMemo } from 'react'
import {
	PANE_TABS_PROPS,
	PaneTabLabel,
	getPaneTabsRootClassName,
} from '../../../workbench/PaneTabs'
import { useWorkbenchTabs } from '../../../workbench/context'

export type PluginWorkbenchView = {
	id: string
	label: string
	count?: number
	content: ReactNode
	hidden?: boolean
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
	headerMode?: 'stacked' | 'inline'
}) {
	const { getActiveTabState, setActiveTabState } = useWorkbenchTabs()
	const visibleViews = useMemo(() => views.filter((view) => !view.hidden), [views])
	const hasHeading = Boolean(eyebrow || title || subtitle)
	const activeViewId = useMemo(
		() => normalizeActiveView(getActiveTabState(scope), visibleViews, fallbackViewId),
		[fallbackViewId, getActiveTabState, scope, visibleViews],
	)

	const selectView = useCallback(
		(viewId: string | null) => {
			if (!viewId || viewId === activeViewId) return
			setActiveTabState(scope, viewId)
		},
		[activeViewId, scope, setActiveTabState],
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
