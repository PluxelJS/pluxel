import { Group, Tabs, Title } from '@mantine/core'
import { useRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useWorkspaceSession } from './workspaceContext'

type DocumentSection = {
	value: string
	label: string
	to: string
	search?: Readonly<Record<string, unknown>>
}

export function DocumentTabs({
	title,
	label,
	value,
	sections,
	actions,
	children,
}: {
	title: string
	label: string
	value: string
	sections: readonly DocumentSection[]
	actions?: ReactNode
	children: ReactNode
}) {
	const router = useRouter()
	const session = useWorkspaceSession()
	return (
		<Tabs
			className="plx-document-tabs"
			value={value}
			keepMounted={false}
			activateTabWithKeyboard={false}
			onChange={(next) => {
				const section = sections.find((item) => item.value === next)
				if (section && next !== value) {
					void router
						.navigate({ to: section.to, search: section.search })
						.catch((error: unknown) => session.report(error))
				}
			}}
		>
			<header className="plx-document-tabs__header">
				<Group className="plx-document-tabs__heading" justify="space-between" gap="sm">
					<Title order={1} size="h2" className="plx-document-tabs__title">
						{title}
					</Title>
					{actions}
				</Group>
				<Tabs.List className="plx-document-tabs__list" aria-label={label}>
					{sections.map((section) => (
						<Tabs.Tab key={section.value} value={section.value}>
							{section.label}
						</Tabs.Tab>
					))}
				</Tabs.List>
			</header>
			{sections.map((section) => (
				<Tabs.Panel key={section.value} value={section.value} className="plx-document-tabs__panel">
					{children}
				</Tabs.Panel>
			))}
		</Tabs>
	)
}
