import { createFileRoute } from '@tanstack/react-router'
import { LiveLog } from '../../log_viewer/LiveLog'

export const Route = createFileRoute('/_workbench/logs')({
	component: () => <LiveLog />,
})
