import { Box, Stack, Title } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceNavigation } from '../../workbench/WorkspaceNavigation'

function AppsRoute() {
	return (
		<Stack h="100%" mih={0} p="var(--plx-page-padding)" gap="md">
			<Title order={2} size="h4">
				应用
			</Title>
			<Box flex={1} mih={0}>
				<WorkspaceNavigation mode="publications" />
			</Box>
		</Stack>
	)
}

export const Route = createFileRoute('/_workbench/apps')({
	staticData: { worksplit: { title: '应用' } },
	component: AppsRoute,
})
