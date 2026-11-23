import { createFileRoute } from '@tanstack/react-router'
import { OutboundHttpSettings } from '../../outbound-http/OutboundHttpSettings'

export const Route = createFileRoute('/_workbench/outbound-http/defaults')({
	component: HostOutboundHttpDefaults,
})

function HostOutboundHttpDefaults() {
	return <OutboundHttpSettings owner={null} />
}
