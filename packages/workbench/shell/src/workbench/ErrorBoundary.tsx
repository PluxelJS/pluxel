import { Component, type ErrorInfo, type ReactNode } from 'react'

interface WorkbenchErrorBoundaryProps {
	pluginName: string
	contributionId: string
	point: string
	children: ReactNode
	fallback?: ReactNode | ((info: { error: Error | null }) => ReactNode)
	onError?: (error: Error, info: ErrorInfo) => void
}

interface WorkbenchErrorBoundaryState {
	hasError: boolean
	error: Error | null
}

class WorkbenchErrorBoundaryImpl extends Component<
	WorkbenchErrorBoundaryProps,
	WorkbenchErrorBoundaryState
> {
	state: WorkbenchErrorBoundaryState = { hasError: false, error: null }

	static getDerivedStateFromError(error: Error): WorkbenchErrorBoundaryState {
		return { hasError: true, error }
	}

	override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		const { pluginName, point, contributionId, onError } = this.props
		console.error(
			`[Workbench:${pluginName}] Failed to render "${point}" (${contributionId})`,
			error,
			errorInfo,
		)
		onError?.(error, errorInfo)
	}

	override render(): ReactNode {
		const { hasError, error } = this.state
		const { children, fallback } = this.props
		if (hasError) {
			if (typeof fallback === 'function') {
				return fallback({ error })
			}
			return fallback ?? null
		}
		return children
	}
}

export function WorkbenchErrorBoundary(props: WorkbenchErrorBoundaryProps) {
	const { contributionId, pluginName, point } = props
	return <WorkbenchErrorBoundaryImpl key={`${pluginName}:${contributionId}:${point}`} {...props} />
}
