import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RouteErrorScreen } from './router/screens/RouteErrorScreen'
import { useCurrentPathname } from './router/useCurrentRoute'

type AppErrorBoundaryProps = {
	children: ReactNode
	pathname: string
}

type AppErrorBoundaryState = {
	error: Error | null
}

class AppErrorBoundaryImpl extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: null }

	static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
		return { error }
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('[AppErrorBoundary] route error', {
			path: this.props.pathname,
			error,
			componentStack: info.componentStack,
		})
	}

	override render() {
		if (this.state.error) {
			return <RouteErrorScreen error={this.state.error} />
		}
		return this.props.children
	}
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
	const pathname = useCurrentPathname()
	return (
		<AppErrorBoundaryImpl key={pathname} pathname={pathname}>
			{children}
		</AppErrorBoundaryImpl>
	)
}
