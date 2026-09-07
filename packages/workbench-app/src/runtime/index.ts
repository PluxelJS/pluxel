export type * from '@pluxel/runtime/web'
export { createRuntimeManagementClient, type RuntimeManagementClient } from '@pluxel/runtime/web'
export {
	RuntimeManagementClientProvider,
	useRuntimeManagementClient,
} from '@pluxel/runtime/web/react'
export {
	createRuntimeSessionClient,
	type RuntimeClientBootstrap,
	type RuntimeSessionClient,
	type RuntimeSessionEvent,
} from '@pluxel/runtime/web/session'

export function runtimeErrorMessage(error: unknown, fallback = '请求失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
