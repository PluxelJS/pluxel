import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RouteErrorScreen } from './screens/RouteErrorScreen'

type RouteErrorBoundaryProps = {
	children: ReactNode
	pathname: string
}

type RouteErrorBoundaryState = {
	error: Error | null
	pathname: string
}

/** Reset failed content on navigation without changing the identity of healthy children. */
export class RouteErrorBoundary extends Component<
	RouteErrorBoundaryProps,
	RouteErrorBoundaryState
> {
	state: RouteErrorBoundaryState = { error: null, pathname: this.props.pathname }

	static getDerivedStateFromProps(
		{ pathname }: RouteErrorBoundaryProps,
		state: RouteErrorBoundaryState,
	): Partial<RouteErrorBoundaryState> | null {
		return pathname === state.pathname ? null : { pathname, error: null }
	}

	static getDerivedStateFromError(error: Error): Pick<RouteErrorBoundaryState, 'error'> {
		return { error }
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('[RouteErrorBoundary] route error', {
			path: this.props.pathname,
			error,
			componentStack: info.componentStack,
		})
	}

	override render() {
		if (this.state.error) {
			return (
				<RouteErrorScreen error={this.state.error} onRetry={() => this.setState({ error: null })} />
			)
		}
		return this.props.children
	}
}
