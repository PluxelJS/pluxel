import { Box, Stack } from '@mantine/core'
import { PageHeader } from '../../../components'
import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceNavigation } from '../../workbench/WorkspaceNavigation'

function AppsRoute() {
	return (
		<Stack h="100%" mih={0} p="var(--plx-page-padding)" gap="md">
			<PageHeader title="应用" />
			<Box flex={1} mih={0} className="plx-appsDirectory">
				<WorkspaceNavigation mode="publications" />
			</Box>
		</Stack>
	)
}

export const Route = createFileRoute('/_workbench/apps')({
	staticData: { worksplit: { title: '应用' } },
	component: AppsRoute,
})
