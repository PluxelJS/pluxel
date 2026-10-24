import '@pluxel/test'

import { type PluginContext, type RootContext } from '@pluxel/core'
import { type Elysia } from 'elysia'
import { expectTypeOf } from 'vitest'

const pluginCtx = {} as PluginContext
expectTypeOf(pluginCtx.elysia).toEqualTypeOf<Elysia | undefined>()

const root = {} as RootContext
expectTypeOf(root.elysia).toEqualTypeOf<Elysia | undefined>()
