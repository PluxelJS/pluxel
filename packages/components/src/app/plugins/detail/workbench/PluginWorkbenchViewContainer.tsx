import type { ReactNode } from 'react'
import { useCallback, useMemo } from 'react'
import { useWorkbenchTabs } from '../../../workbench/context'

export type PluginWorkbenchView = {
	id: string
	label: string
	count?: number
	content: ReactNode
	hidden?: boolean
}

function normalizeActiveView(value: unknown, views: PluginWorkbenchView[], fallbackId?: string) {
	if (!views.length) return ''
	if (typeof value === 'string' && views.some((view) => view.id === value)) return value
	if (fallbackId && views.some((view) => view.id === fallbackId)) return fallbackId
	return views[0]?.id ?? ''
}

function PluginWorkbenchViewTabs({
	activeTab,
	label,
	views,
	onChange,
}: {
	activeTab: string
	label: string
	views: PluginWorkbenchView[]
	onChange: (viewId: string) => void
}) {
	return (
		<div className="plx-pluginWorkbench__viewTabs" role="tablist" aria-label={label}>
			{views.map((view) => (
				<button
					key={view.id}
					type="button"
					role="tab"
					aria-selected={activeTab === view.id}
					className="plx-pluginWorkbench__viewTab"
					data-active={activeTab === view.id ? 'true' : 'false'}
					onClick={() => onChange(view.id)}
				>
					<span className="plx-pluginWorkbench__viewTabLabel">{view.label}</span>
					{typeof view.count === 'number' ? (
						<span className="plx-pluginWorkbench__viewTabCount">{view.count}</span>
					) : null}
				</button>
			))}
		</div>
	)
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
		(viewId: string) => {
			if (viewId === activeViewId) return
			setActiveTabState(scope, viewId)
		},
		[activeViewId, scope, setActiveTabState],
	)

	return (
		<div className={className}>
			<div className="plx-pluginWorkbench__viewHeader" data-mode={headerMode}>
				{headerMode === 'inline' ? (
					<div className="plx-pluginWorkbench__viewHeaderRow">
						<PluginWorkbenchViewTabs
							activeTab={activeViewId}
							label={label}
							views={visibleViews}
							onChange={selectView}
						/>
						{rightMeta ? (
							<div className="plx-pluginWorkbench__viewMetaAside">{rightMeta}</div>
						) : null}
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
									<div className="plx-pluginWorkbench__viewMetaAside">{rightMeta}</div>
								) : null}
							</div>
						) : null}
						<PluginWorkbenchViewTabs
							activeTab={activeViewId}
							label={label}
							views={visibleViews}
							onChange={selectView}
						/>
					</>
				)}
			</div>

			<div className="plx-pluginWorkbench__viewBody">
				{visibleViews.map((view) => (
					<div
						key={view.id}
						className="plx-pluginWorkbench__viewPanel"
						data-active={activeViewId === view.id ? 'true' : 'false'}
					>
						{view.content}
					</div>
				))}
			</div>
		</div>
	)
}
