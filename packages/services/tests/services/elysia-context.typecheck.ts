import { ElysiaApp } from '@pluxel/services/elysia'
import { defineServiceRef, type PluginContext, type RootContext } from '@pluxel/core'
import { expectTypeOf } from 'vitest'

const ElysiaAppRef = defineServiceRef<ElysiaApp>()
const pluginCtx = {} as PluginContext
expectTypeOf(pluginCtx.service(ElysiaApp)).toEqualTypeOf<ElysiaApp>()
expectTypeOf(pluginCtx.service(ElysiaAppRef)).toEqualTypeOf<ElysiaApp | undefined>()

const root = {} as RootContext
// @ts-expect-error ElysiaApp requires a Plugin owner Context.
root.service(ElysiaApp)
