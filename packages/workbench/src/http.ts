import { mountWorkbenchShell } from './shell/mount'
import { defineHostService, type HostService } from '@pluxel/host'
import { HttpServer } from '@pluxel/services/http'
import { WorkbenchHost } from './token'
import type { WorkbenchShellOptions } from './shell'

/** Mount only the official browser Shell. Management HTTP and its Workbench bindings are explicit services. */
export function workbenchHttp(options: WorkbenchShellOptions = {}): HostService<readonly []> {
	const snapshot = Object.freeze({ ...options })
	return defineHostService({
		name: 'WorkbenchHTTP',
		capabilities: [],
		requires: { http: HttpServer, workbench: WorkbenchHost },
		prepare: ({ ctx, dependencies, effects }) => {
			const mounted = mountWorkbenchShell(ctx, snapshot)
			effects.defer(mounted.dispose, { tag: 'WorkbenchShell', phase: 'shutdown' })
			const unmount = dependencies.http.mountFallback({
				fetch: mounted.handler,
				matchesRequest: mounted.handler.matchesRequest,
			})
			effects.defer(unmount, { tag: 'WorkbenchShellRoute', phase: 'shutdown' })
		},
	})
}
export type { WorkbenchShellOptions } from './shell'
