import type { CSSProperties, ReactNode } from 'react'

interface PluginPanelProps {
	title?: ReactNode
	description?: ReactNode
	rightSection?: ReactNode
	children?: ReactNode
	gap?: number | string
	padding?: number | string
	className?: string
	style?: CSSProperties
}

const ROOT_STYLE = {
	height: '100%',
	width: '100%',
	display: 'flex',
	flexDirection: 'column' as const,
	minHeight: 0,
	minWidth: 0,
}

const CONTENT_STYLE: CSSProperties = {
	flex: 1,
	minHeight: 0,
	minWidth: 0,
	width: '100%',
	display: 'flex',
	flexDirection: 'column',
}

export function PluginPanel({
	title,
	description,
	rightSection,
	children,
	gap = 8,
	padding = 12,
	className,
	style,
}: PluginPanelProps) {
	return (
		<div
			className={['plx-pluginPanel', className].filter(Boolean).join(' ')}
			style={{
				...ROOT_STYLE,
				...style,
				padding: typeof padding === 'number' ? `${padding}px` : padding,
				['--plx-plugin-panel-gap' as string]: typeof gap === 'number' ? `${gap}px` : gap,
			}}
		>
			<div className="plx-pluginPanel__stack" style={{ flex: 1, minHeight: 0 }}>
				{title || description || rightSection ? (
					<div className="plx-pluginPanel__header">
						<div className="plx-pluginPanel__heading">
							{typeof title === 'string' ? (
								<div className="plx-pluginPanel__title">{title}</div>
							) : (
								title
							)}
							{typeof description === 'string' ? (
								<div className="plx-pluginPanel__description">{description}</div>
							) : (
								description
							)}
						</div>
						{rightSection && <div className="plx-pluginPanel__aside">{rightSection}</div>}
					</div>
				) : null}
				<div style={CONTENT_STYLE}>{children}</div>
			</div>
		</div>
	)
}
