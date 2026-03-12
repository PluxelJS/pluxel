import '@pluxel/test/setup'

import type { Context as PluginContext } from '@pluxel/core'
import { expectTypeOf, it } from 'vitest'

import { createElysiaApp } from '@pluxel/hmr/services/http/elysia'

it('decorates plugin context onto Elysia handlers', () => {
	const pluginCtx = {} as PluginContext
	const app = createElysiaApp(pluginCtx)

	app.get('/probe', (c) => {
		expectTypeOf(c.pluginCtx).toEqualTypeOf<PluginContext>()
		return 'ok'
	})
})
