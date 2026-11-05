import { createFileRoute } from '@tanstack/react-router'
import { LogsPage } from '../../log_viewer/LogsPage'
import { validateLogsSearch } from '../logsSearch'

export const Route = createFileRoute('/_workbench/logs')({
	validateSearch: validateLogsSearch,
	staticData: {
		worksplit: {
			title: '日志',
			documentKey: ({ search }) =>
				JSON.stringify(['logs', 'plugin' in search ? search.plugin : null]),
		},
	},
	component: LogsRoute,
})

function LogsRoute() {
	return <LogsPage search={Route.useSearch()} />
}
