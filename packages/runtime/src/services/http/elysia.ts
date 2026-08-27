import type { Context as PluginContext } from '@pluxel/core'
import { Elysia } from 'elysia'
import type { ElysiaConfig } from 'elysia/types'

export type CreateHostElysiaAppOptions<BasePath extends string = ''> = ElysiaConfig<
	BasePath,
	'local'
>

export function createHostElysiaApp<const BasePath extends string = ''>(
	ctx: PluginContext,
	options: CreateHostElysiaAppOptions<BasePath> = {},
) {
	return new Elysia<BasePath>({ precompile: false, ...options }).decorate({ pluginCtx: ctx })
}

export type AnyHostElysiaApp = ReturnType<typeof createHostElysiaApp<any>>
