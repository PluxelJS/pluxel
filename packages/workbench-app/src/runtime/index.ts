export type * from '@pluxel/management/client'
export {
	createRuntimeManagementClient,
	type RuntimeManagementClient,
} from '@pluxel/management/client'
export {
	RuntimeManagementClientProvider,
	useRuntimeManagementClient,
} from '@pluxel/management/react'
export {
	createRuntimeSessionClient,
	type RuntimeClientBootstrap,
	type RuntimeSessionClient,
	type RuntimeSessionEvent,
} from '@pluxel/management/session'

export function runtimeErrorMessage(error: unknown, fallback = '请求失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
