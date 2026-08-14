import { createFileRoute } from '@tanstack/react-router'
import { AgentToolsScreen } from '../../agent-tools/AgentToolsScreen'

export const Route = createFileRoute('/_workbench/agent-tools')({
	component: AgentToolsScreen,
})
