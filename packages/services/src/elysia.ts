import { resolveContextService } from '@pluxel/core/internal'
import { ElysiaRuntime, HostElysiaRuntime } from './elysia/runtime'
import type { Elysia } from 'elysia'
import { installRootService, installScopeService } from '@pluxel/core/host'
import { defineHostService, type PluginHost, type HostService } from '@pluxel/host'
import { ElysiaApplicationDirectory } from './elysia/ElysiaApplicationDirectory'

/** Native Elysia application owned by one Plugin generation and shared with its Parts. */
export abstract class ElysiaApp {
	static readonly access = 'owner' as const
}
export interface ElysiaApp extends Elysia {}
export abstract class ElysiaDirectory {
	static readonly access = 'root' as const
}
export interface ElysiaDirectory extends ElysiaApplicationDirectory {}

/** Install owner Elysia applications. Management, Workbench and the srvx listener are installed separately. */
export function elysia(): HostService {
	return defineHostService({
		name: 'Elysia',
		provides: [
			installRootService(ElysiaDirectory, { create: () => new ElysiaApplicationDirectory() }),
			installScopeService(ElysiaApp, {
				create: (ctx) => resolveContextService(ctx.root, ElysiaDirectory).applicationFor(ctx),
			}),
			installRootService(ElysiaRuntime, {
				create: (ctx) => new HostElysiaRuntime(ctx, resolveContextService(ctx, ElysiaDirectory)),
			}),
		],
		prepare: ({ ctx, effects }) => {
			effects.defer(
				() => (resolveContextService(ctx, ElysiaRuntime) as HostElysiaRuntime).close(),
				{
					tag: 'ElysiaEndpoints',
					phase: 'shutdown',
				},
			)
		},
		lifecycle: (ctx) => resolveContextService(ctx, ElysiaDirectory).lifecycleHooks,
	})
}

/** Fetch handler for a Host with elysia() installed; the caller owns the transport and Host cleanup. */
export function createElysiaHandler(host: PluginHost): (request: Request) => Promise<Response> {
	const server = resolveContextService(host.ctx, ElysiaRuntime)
	return server.fetch.bind(server)
}
