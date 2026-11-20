import { Stack, Title } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { OutboundHttpSettings } from '../../outbound-http/OutboundHttpSettings'

export const Route = createFileRoute('/_workbench/outbound-http_/defaults')({
	staticData: { worksplit: { title: '宿主出站默认设置' } },
	component: HostOutboundHttpDefaults,
})

function HostOutboundHttpDefaults() {
	return (
		<Stack h="100%" gap="md" p="var(--plx-page-padding)" style={{ minWidth: 0, overflow: 'auto' }}>
			<Title order={1} size="h3">
				宿主出站默认设置
			</Title>
			<OutboundHttpSettings owner={null} />
		</Stack>
	)
}
