import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'
import { OUTBOUND_HTTP_DEFAULTS_PATH, OUTBOUND_HTTP_PATH } from '../../outbound-http/paths'
import { DocumentTabs } from '../../workbench/DocumentTabs'
import { validateLogsSearch } from '../logsSearch'

export const Route = createFileRoute('/_workbench/outbound-http')({
	validateSearch: (search) => ({ plugin: validateLogsSearch({ plugin: search.plugin }).plugin }),
	staticData: { worksplit: { title: '受管出站 HTTP' } },
	component: OutboundHttpRoute,
})

function OutboundHttpRoute() {
	const search = Route.useSearch()
	const defaults = useMatch({
		from: '/_workbench/outbound-http/defaults',
		shouldThrow: false,
		select: () => true,
	})
	return (
		<DocumentTabs
			title="受管出站 HTTP"
			label="出站 HTTP"
			value={defaults ? 'defaults' : 'activity'}
			sections={[
				{ value: 'activity', label: '联网概览', to: OUTBOUND_HTTP_PATH, search },
				{ value: 'defaults', label: '宿主默认设置', to: OUTBOUND_HTTP_DEFAULTS_PATH, search },
			]}
		>
			<Outlet />
		</DocumentTabs>
	)
}
