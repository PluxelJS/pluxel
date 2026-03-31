import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RouteError } from './router/views'
import { useCurrentPathname } from './router/useCurrentRoute'

type AppErrorBoundaryProps = {
	children: ReactNode
	resetKey: string
}

type AppErrorBoundaryState = {
	error: Error | null
	errorKey: string | null
}

class AppErrorBoundaryImpl extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: null, errorKey: null }

	static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
		return { error, errorKey: null }
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		if (this.state.errorKey !== this.props.resetKey) {
			this.setState({ errorKey: this.props.resetKey })
		}
		console.error('[AppErrorBoundary] route error', {
			path: this.props.resetKey,
			error,
			componentStack: info.componentStack,
		})
	}

	override componentDidUpdate(prevProps: AppErrorBoundaryProps) {
		if (
			this.state.error &&
			this.state.errorKey &&
			prevProps.resetKey !== this.props.resetKey &&
			this.props.resetKey !== this.state.errorKey
		) {
			this.setState({ error: null, errorKey: null })
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
	const pathname = useCurrentPathname()
	return <AppErrorBoundaryImpl resetKey={pathname}>{children}</AppErrorBoundaryImpl>
}
