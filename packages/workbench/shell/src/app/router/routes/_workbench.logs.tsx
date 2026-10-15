import { createFileRoute } from '@tanstack/react-router'
import { LogsPage } from '../../log_viewer/LogsPage'
import { validateLogsSearch } from '../logsSearch'

export const Route = createFileRoute('/_workbench/logs')({
	validateSearch: validateLogsSearch,
	staticData: { worksplit: { title: '日志', identitySearch: ['plugin'] } },
	component: LogsRoute,
})

function LogsRoute() {
	return <LogsPage search={Route.useSearch()} />
}
