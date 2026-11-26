import { parsePluginNodeReference } from '@pluxel/core'
import { createFileRoute } from '@tanstack/react-router'
import { OutboundHttpScreen } from '../../outbound-http/OutboundHttpScreen'

export const Route = createFileRoute('/_workbench/outbound-http/')({
	component: OutboundHttpOverview,
})

function OutboundHttpOverview() {
	const { plugin } = Route.useSearch()
	return (
		<OutboundHttpScreen
			key={plugin}
			owner={plugin ? parsePluginNodeReference(plugin) : undefined}
		/>
	)
}
