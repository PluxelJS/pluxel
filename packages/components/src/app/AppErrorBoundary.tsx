import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { RouteError } from './routes/RouteError'

type AppErrorBoundaryProps = {
	children: ReactNode
	resetKey: string
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
			path: this.props.resetKey,
			error,
			componentStack: info.componentStack,
		})
	}

	override componentDidUpdate(prevProps: AppErrorBoundaryProps) {
		if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
			this.setState({ error: null })
		}
	}

	override render() {
		if (this.state.error) {
			return <RouteError error={this.state.error} />
		}
		return this.props.children
	}
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	return <AppErrorBoundaryImpl resetKey={pathname}>{children}</AppErrorBoundaryImpl>
}
