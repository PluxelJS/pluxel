import { Box, Stack, Text, Title } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceNavigation } from '../../workbench/WorkspaceNavigation'

function AppsRoute() {
	return (
		<Stack h="100%" mih={0} p="md" gap="sm">
			<Title order={2} size="h4">
				应用
			</Title>
			<Text size="sm" c="dimmed">
				打开业务应用，在标签页中处理日常工作。
			</Text>
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
