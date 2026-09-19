import { publishWorkbenchShellMount } from './shell/mount'
import { normalizeWorkbenchUiBasePath } from './shell/config'
import { defineHostService, type HostService } from '@pluxel/host'
import { resolveContextCapability } from '@pluxel/core/host'
import { HttpServer } from '@pluxel/services/http'
import { managementHttp } from '@pluxel/management/http'
import { createWorkbenchArtifactHandler, requireWorkbench } from './server'
import { WorkbenchHost } from './token'
import { createWorkbenchShellHandler, type WorkbenchShellOptions } from './shell'

/** Mount the official UI, authenticated management session and Workbench artifacts. */
export function workbenchHttp(options: WorkbenchShellOptions = {}): HostService {
	const management = managementHttp({
		bindings: (ctx) => ({
			createWorkbench: (principal, identity) =>
				requireWorkbench(ctx).createSession(principal, identity),
			artifacts: createWorkbenchArtifactHandler(ctx),
		}),
	})
	return defineHostService({
		...management,
		name: 'WorkbenchHTTP',
		requires: { ...management.requires, workbench: WorkbenchHost },
		prepare: async (environment) => {
			await management.prepare?.(environment)
			const shell = await createWorkbenchShellHandler(options)
			environment.effects.defer(
				publishWorkbenchShellMount(
					environment.ctx,
					normalizeWorkbenchUiBasePath(options.uiBasePath),
				),
				{ tag: 'WorkbenchShellMount', phase: 'shutdown' },
			)
			const unmount = resolveContextCapability(environment.ctx, HttpServer).mountFallback({
				fetch: shell,
				matchesRequest: shell.matchesRequest,
			})
			environment.effects.defer(unmount, { tag: 'WorkbenchShell', phase: 'shutdown' })
		},
	})
}
export type { WorkbenchShellOptions } from './shell'
