import { parsePluginNodeReference } from '@pluxel/core'
import { createFileRoute } from '@tanstack/react-router'
import { OutboundHttpScreen } from '../../outbound-http/OutboundHttpScreen'
import { validateLogsSearch } from '../logsSearch'

export const Route = createFileRoute('/_workbench/outbound-http')({
	validateSearch: (search) => ({ plugin: validateLogsSearch({ plugin: search.plugin }).plugin }),
	staticData: { worksplit: { title: '受管出站 HTTP' } },
	component: OutboundHttpRoute,
})

function OutboundHttpRoute() {
	const { plugin } = Route.useSearch()
	return (
		<OutboundHttpScreen
			key={plugin}
			owner={plugin ? parsePluginNodeReference(plugin) : undefined}
		/>
	)
}
