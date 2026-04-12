import { createFileRoute } from '@tanstack/react-router'
import { OpsExplorerScreen } from '../../ops/OpsExplorerScreen'

export const Route = createFileRoute('/_workbench/ops')({
	component: OpsExplorerScreen,
})
