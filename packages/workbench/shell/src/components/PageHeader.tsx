import { Title } from '@mantine/core'
import type { ReactNode } from 'react'

/** One header row shared by built-in pages: title and quiet facts on the left, actions on the right. */
export function PageHeader({
	title,
	meta,
	actions,
}: {
	title: ReactNode
	meta?: ReactNode
	actions?: ReactNode
}) {
	return (
		<header className="plx-pageHeader">
			<div className="plx-pageHeader__heading">
				<Title order={1} className="plx-pageHeader__title">
					{title}
				</Title>
				{meta ? <div className="plx-pageHeader__meta">{meta}</div> : null}
			</div>
			{actions ? <div className="plx-pageHeader__actions">{actions}</div> : null}
		</header>
	)
}
