import type { Context } from '@pluxel/core'

import {
	type PluginGatedDef,
	resolveIsPluginEnabled,
	type PluginGatedOptions,
} from '../routing/pluginGatedRoutes'
import { createElysiaApp, type AnyElysiaApp } from './elysia'

type BaseElysiaApp = AnyElysiaApp

export interface PluginGatedModuleDef extends PluginGatedDef {
	build: (app: BaseElysiaApp) => BaseElysiaApp
}

function createPluginGatedModule(
	ctx: Context,
	module: PluginGatedModuleDef,
	isPluginEnabled: ReturnType<typeof resolveIsPluginEnabled>,
) {
	const routes = module.build(
		createElysiaApp(ctx, {
			aot: true,
			name: `plugin-gated:${module.plugin}:${module.id}:routes`,
		}),
	)

	return createElysiaApp(ctx, {
		aot: true,
		name: `plugin-gated:${module.plugin}:${module.id}`,
	}).onBeforeHandle(({ status }) => {
		if (!isPluginEnabled(module.plugin, ctx)) return status(404, 'Not Found')
		return undefined
	}).use(routes)
}

export function createPluginGatedRouter(
	ctx: Context,
	modules: readonly PluginGatedModuleDef[],
	options: PluginGatedOptions = {},
) {
	const isPluginEnabled = resolveIsPluginEnabled(options)
	let root = createElysiaApp(ctx, {
		aot: true,
		name: 'plugin-gated:root',
	})

	for (const module of modules) root = root.use(createPluginGatedModule(ctx, module, isPluginEnabled))

	return root
}
