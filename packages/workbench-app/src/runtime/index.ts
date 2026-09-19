export type * from '@pluxel/management/client'
export {
	createRuntimeManagementClient,
	type RuntimeManagementClient,
} from '@pluxel/management/client'
export {
	RuntimeManagementClientProvider,
	useRuntimeManagementClient,
} from '@pluxel/management/react'
import {
	createRuntimeSessionClient as createSessionClient,
	type RuntimeClientBootstrap as SessionBootstrap,
	type RuntimeSessionClient as SessionClient,
} from '@pluxel/management/session'
import type { WorkbenchSessionApi } from '@pluxel/workbench/client'
export type { RuntimeSessionEvent } from '@pluxel/management/session'

// This application owns the concrete Workbench API carried by the shared transport.
export const createRuntimeSessionClient = createSessionClient<WorkbenchSessionApi>
export type RuntimeClientBootstrap = SessionBootstrap<WorkbenchSessionApi>
export type RuntimeSessionClient = SessionClient<WorkbenchSessionApi>

export function runtimeErrorMessage(error: unknown, fallback = '请求失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
