import { useEffect } from 'react'
import { useOptionalWorkbenchDocument } from '../../workbench/document'
import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router'
import { RouteErrorBoundary } from '../RouteErrorBoundary'
import { useCurrentPathname } from '../useCurrentRoute'

export const Route = createRootRoute({ component: DocumentRoot })

function DocumentRoot() {
	const pathname = useCurrentPathname()
	const router = useRouter()
	const document = useOptionalWorkbenchDocument()
	useEffect(() => {
		if (!document) return
		document.state.navigate = router.navigate
		return () => {
			document.state.navigate = undefined
		}
	}, [document, router])
	return (
		<RouteErrorBoundary pathname={pathname}>
			<Outlet />
		</RouteErrorBoundary>
	)
}
