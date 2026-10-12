import { createRootRoute, Outlet } from '@tanstack/react-router'
import { RouteErrorBoundary } from '../RouteErrorBoundary'
import { useCurrentPathname } from '../useCurrentRoute'

export const Route = createRootRoute({ component: DocumentRoot })

function DocumentRoot() {
	const pathname = useCurrentPathname()
	return (
		<RouteErrorBoundary pathname={pathname}>
			<Outlet />
		</RouteErrorBoundary>
	)
}
