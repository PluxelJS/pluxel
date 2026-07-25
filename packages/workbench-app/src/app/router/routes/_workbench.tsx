import { createFileRoute } from '@tanstack/react-router'
import { WorkbenchShell } from '../../workbench/WorkbenchShell'

export const Route = createFileRoute('/_workbench')({
	component: WorkbenchShell,
})
