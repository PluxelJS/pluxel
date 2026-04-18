import { createFileRoute } from '@tanstack/react-router'
import { HMR_SECURITY_BASE } from '../../../runtime'
import { useCurrentPathname } from '../useCurrentRoute'
import { SecurityShell } from '../../security/SecurityShell'
import { WorkbenchShell } from '../../workbench/WorkbenchShell'

function WorkbenchRouteShell() {
	const pathname = useCurrentPathname()
	if (pathname === HMR_SECURITY_BASE) return <SecurityShell />
	return <WorkbenchShell />
}

export const Route = createFileRoute('/_workbench')({
	component: WorkbenchRouteShell,
})
