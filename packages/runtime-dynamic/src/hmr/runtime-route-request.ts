import type { IncomingMessage } from 'node:http'
import type { Context } from '@pluxel/core'
import { requireRuntimeHttpService } from '@pluxel/runtime/internal'
import { shouldHandleRuntimeViteRequest } from '../../../runtime-dev/src/internal/vite-route-request.ts'

export type RuntimeHttpRouteContext = Context

export function isRuntimeHttpRouteRequest(
	request: IncomingMessage,
	ctx: RuntimeHttpRouteContext,
): boolean {
	const url = request.url ?? '/'
	const http = requireRuntimeHttpService(ctx)
	const workbenchEnabled = ctx.workbench !== undefined
	return shouldHandleRuntimeViteRequest({
		url,
		method: request.method,
		accept: String(request.headers.accept ?? ''),
		workbenchEnabled,
		matchesMountedRoute: (pathname) => http.matchesMountedRoute(pathname),
		matchesWorkbenchUiRoute: (pathname) => http.matchesWorkbenchUiRoute(pathname),
	})
}
