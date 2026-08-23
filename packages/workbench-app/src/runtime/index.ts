import { createRuntimeManagementClient, resolveAdminAccessLandingPath } from '@pluxel/runtime/web'
import {
	RuntimeManagementClientProvider,
	useRuntimeManagementClient,
} from '@pluxel/runtime/web/react'
import {
	createRuntimeTransportClient,
	RUNTIME_SECURITY_BASE,
	type RuntimeTransportClient,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web/internal'

export type * from '@pluxel/runtime/web'
export {
	resolveAdminAccessLandingPath,
	RUNTIME_SECURITY_BASE,
	RuntimeManagementClientProvider,
	RuntimeTransportClientProvider,
	useRuntimeManagementClient,
	useRuntimeTransportClient,
}

let management: ReturnType<typeof createRuntimeManagementClient> | null = null
let transport: RuntimeTransportClient | null = null

export function getRuntimeManagementClient() {
	if (!management) {
		management = createRuntimeManagementClient({
			fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
		})
	}
	return management
}

/** @internal Official React View-host transport pending the Level 2 protocol. */
export function getRuntimeTransportClient(): RuntimeTransportClient {
	if (!transport) {
		transport = createRuntimeTransportClient({
			fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
		})
	}
	return transport
}

export function runtimeErrorMessage(error: unknown, fallback = '请求失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
