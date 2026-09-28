import { createRootRoute } from '@tanstack/react-router'
import { RouteErrorBoundary } from '../RouteErrorBoundary'
import { useCurrentPathname } from '../useCurrentRoute'
import { AppProviders } from '../../frames/AppProviders'

export const Route = createRootRoute({
	component: RootRoute,
})

function RootRoute() {
	const pathname = useCurrentPathname()
	return (
		<RouteErrorBoundary pathname={pathname}>
			<AppProviders />
		</RouteErrorBoundary>
	)
}
