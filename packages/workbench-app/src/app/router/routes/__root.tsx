import { createRootRoute } from '@tanstack/react-router'
import { AppErrorBoundary } from '../../AppErrorBoundary'
import { AppProviders } from '../../frames/AppProviders'

export const Route = createRootRoute({
	component: () => (
		<AppErrorBoundary>
			<AppProviders />
		</AppErrorBoundary>
	),
})
