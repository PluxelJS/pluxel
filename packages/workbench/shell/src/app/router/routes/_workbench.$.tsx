import { createFileRoute } from '@tanstack/react-router'
import { WorkbenchDeclaredRouteScreen } from '../workbench/WorkbenchDeclaredRouteScreen'
import { useCurrentPathname } from '../useCurrentRoute'
export const Route = createFileRoute('/_workbench/$')({ component: DeclaredRoute })
function DeclaredRoute() {
	return <WorkbenchDeclaredRouteScreen pathname={useCurrentPathname()} />
}
