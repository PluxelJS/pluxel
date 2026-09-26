import { ElysiaRuntime, HostElysiaRuntime } from './elysia/runtime'
import type { Elysia } from 'elysia'
import {
	defineContextCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { defineHostService, type PluginHost, type HostService } from '@pluxel/host'
import { ElysiaApplicationDirectory } from './elysia/ElysiaApplicationDirectory'

/** Native Elysia application owned by one Plugin generation and shared with its Parts. */
export const ElysiaApp = defineContextCapability<Elysia>('services.elysia', {
	access: 'owner',
	property: 'elysia',
})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly elysia?: Elysia
	}
}

const ElysiaDirectory = defineContextCapability<ElysiaApplicationDirectory>(
	'services.elysia.directory',
	{ access: 'root' },
)

/** Install owner Elysia applications. Management, Workbench and the srvx listener are installed separately. */
export function elysia(): HostService {
	return defineHostService({
		name: 'Elysia',
		capabilities: [
			installRootCapability(ElysiaDirectory, { create: () => new ElysiaApplicationDirectory() }),
			installScopeCapability(ElysiaApp, {
				property: 'elysia',
				create: (ctx) => resolveContextCapability(ctx.root, ElysiaDirectory).applicationFor(ctx),
			}),
			installRootCapability(ElysiaRuntime, {
				create: (ctx) => new HostElysiaRuntime(ctx, resolveContextCapability(ctx, ElysiaDirectory)),
			}),
		],
		prepare: ({ ctx, effects }) => {
			effects.defer(
				() => (resolveContextCapability(ctx, ElysiaRuntime) as HostElysiaRuntime).close(),
				{
					tag: 'ElysiaEndpoints',
					phase: 'shutdown',
				},
			)
		},
		lifecycle: (ctx) => resolveContextCapability(ctx, ElysiaDirectory).lifecycleHooks,
	})
}

/** Fetch handler for a Host with elysia() installed; the caller owns the transport and Host cleanup. */
export function createElysiaHandler(host: PluginHost): (request: Request) => Promise<Response> {
	const server = resolveContextCapability(host.ctx, ElysiaRuntime)
	return server.fetch.bind(server)
}
