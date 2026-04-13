import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ExtensionErrorBoundaryProps {
	pluginName: string
	extensionId: string
	point: string
	children: ReactNode
	fallback?: ReactNode | ((info: { error: Error | null }) => ReactNode)
	onError?: (error: Error, info: ErrorInfo) => void
}

interface ExtensionErrorBoundaryState {
	hasError: boolean
	error: Error | null
}

export class ExtensionErrorBoundary extends Component<
	ExtensionErrorBoundaryProps,
	ExtensionErrorBoundaryState
> {
	state: ExtensionErrorBoundaryState = { hasError: false, error: null }

	static getDerivedStateFromError(error: Error): ExtensionErrorBoundaryState {
		return { hasError: true, error }
	}

	override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		const { pluginName, point, extensionId, onError } = this.props
		console.error(
			`[Extension:${pluginName}] Failed to render "${point}" (${extensionId})`,
			error,
			errorInfo,
		)
		onError?.(error, errorInfo)
	}

	override componentDidUpdate(prevProps: ExtensionErrorBoundaryProps) {
		if (
			prevProps.extensionId !== this.props.extensionId ||
			prevProps.pluginName !== this.props.pluginName
		&& this.state.hasError
		) {
			this.setState({ hasError: false, error: null })
		}
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
