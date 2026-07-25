import { Badge, type TabsProps } from '@mantine/core'
import type { ReactNode } from 'react'

export const PANE_TABS_PROPS: Partial<TabsProps> = {
	autoContrast: true,
	color: 'brand',
	variant: 'default',
}

export function getPaneTabsRootClassName(variant: 'panel' | 'toolbar') {
	return `plx-paneTabs plx-paneTabs--${variant}`
}

export function PaneTabLabel({ badge, label }: { badge?: ReactNode; label: ReactNode }) {
	return (
		<span className="plx-paneTabs__label">
			<span className="plx-paneTabs__labelText">{label}</span>
			{badge ? (
				<Badge size="xs" variant="light" color="gray" radius="xl">
					{badge}
				</Badge>
			) : null}
		</span>
	)
}
