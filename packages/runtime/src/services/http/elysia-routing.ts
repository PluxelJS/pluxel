import type { Context } from '@pluxel/core'
import type { AnyElysia } from 'elysia'

import {
	type PluginGatedDef,
	resolveIsPluginRunning,
	type PluginGatedOptions,
} from '../routing/pluginGatedRoutes'
import { createHostElysiaApp, type AnyHostElysiaApp } from './elysia'

type BaseElysiaApp = AnyHostElysiaApp

export interface PluginGatedModuleDef extends PluginGatedDef {
	build: (app: BaseElysiaApp) => BaseElysiaApp
}

function createPluginGatedModule(
	ctx: Context,
	module: PluginGatedModuleDef,
	isPluginRunning: ReturnType<typeof resolveIsPluginRunning>,
) {
	const routes = module.build(
		createHostElysiaApp(ctx, {
			precompile: true,
			name: `plugin-gated:${module.plugin}:${module.id}:routes`,
		}),
	)

	return createHostElysiaApp(ctx, {
		precompile: true,
		name: `plugin-gated:${module.plugin}:${module.id}`,
	})
		.beforeHandle(({ status }) => {
			if (!isPluginRunning(module.plugin, ctx)) return status(404, 'Not Found')
			return undefined
		})
		.use(routes)
}

export function createPluginGatedRouter(
	ctx: Context,
	modules: readonly PluginGatedModuleDef[],
	options: PluginGatedOptions = {},
) {
	const isPluginRunning = resolveIsPluginRunning(options)
	let root: AnyElysia = createHostElysiaApp(ctx, {
		precompile: true,
		name: 'plugin-gated:root',
	})

	for (const module of modules)
		root = root.use(createPluginGatedModule(ctx, module, isPluginRunning))

	return root
}
