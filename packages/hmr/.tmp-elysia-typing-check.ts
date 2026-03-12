import type { Context as PluginContext } from '@pluxel/core'
import { Elysia, type AnyElysia, type ElysiaConfig } from 'elysia'

type CreateElysiaAppOptions<BasePath extends string = ''> = ElysiaConfig<BasePath>
function createElysiaApp<const BasePath extends string = ''>(ctx: PluginContext, options: CreateElysiaAppOptions<BasePath> = {}) {
  return new Elysia<BasePath>({ aot: false, ...options }).decorate({ pluginCtx: ctx })
}

function a<T extends ReturnType<typeof createElysiaApp>>(app: T) {
  app.get('/x', (c) => {
    c.pluginCtx
    c.nonexistent
    return 'ok'
  })
}

function b<T extends AnyElysia>(app: T) {
  app.get('/x', (c) => {
    c.pluginCtx
    c.nonexistent
    return 'ok'
  })
}
