import '@pluxel/runtime/test'

import type { PluginContext, RootContext } from '@pluxel/core'
import type { Elysia } from 'elysia'
import { expectTypeOf, it } from 'vitest'

it('exposes native Elysia only on Plugin generation contexts', () => {
	const pluginCtx = {} as PluginContext
	expectTypeOf(pluginCtx.elysia).toEqualTypeOf<Elysia>()

	const root = {} as RootContext
	// @ts-expect-error Root Context does not author a Plugin generation application.
	void root.elysia
})
