import type { Context as PluginContext } from '@pluxel/core'
import { Elysia, type ElysiaConfig } from 'elysia'

export type CreateElysiaAppOptions<BasePath extends string = ''> = ElysiaConfig<BasePath>

export function createElysiaApp<const BasePath extends string = ''>(
	ctx: PluginContext,
	options: CreateElysiaAppOptions<BasePath> = {},
) {
	// Default to non-AOT so plugin-side route trees stay compatible with HMR-driven mount/replace flows.
	// Callers can still opt into `aot: true` for stable internal trees that are built once.
	return new Elysia<BasePath>({ aot: false, ...options }).decorate({ pluginCtx: ctx })
}

export type AnyElysiaApp = ReturnType<typeof createElysiaApp<any>>
