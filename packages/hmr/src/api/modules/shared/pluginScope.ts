import type { Context as PlxContext, PluginConstructor } from '@pluxel/core'
import { GraphQLError } from 'graphql'
import * as v from 'valibot'

import { PluginDependency } from '../../schema'
import type { PluginScopeOutput } from '../../schema'

const PLUGIN_CTOR = Symbol('pluginCtor')

type InternalScope = PluginScopeOutput & { [PLUGIN_CTOR]?: PluginConstructor }

export function ensurePlugin(pCtx: PlxContext, name: string): PluginConstructor {
	const ctor = pCtx.loader.getPluginClassByName(name)
	if (!ctor) {
		throw new GraphQLError('Plugin not found', {
			extensions: { code: 'NOT_FOUND', name },
		})
	}
	return ctor
}

export function createPluginScope(pCtx: PlxContext, name: string): PluginScopeOutput {
	const scope = { __typename: 'PluginScope' as const, name } as InternalScope
	scope[PLUGIN_CTOR] = ensurePlugin(pCtx, name)
	return scope
}

export function getScopeCtor(pCtx: PlxContext, scope: PluginScopeOutput): PluginConstructor {
	const internal = scope as InternalScope
	if (internal[PLUGIN_CTOR]) return internal[PLUGIN_CTOR]!
	return ensurePlugin(pCtx, scope.name)
}

export function getPluginDependencies(pCtx: PlxContext, ctor: PluginConstructor) {
	return pCtx.loader
		.getPluginDependenciesInfo(ctor)
		.map((dep) => ({
			__typename: 'PluginDependency' as const,
			name: dep.name,
			optional: dep.optional,
			isRunning: dep.isRunning,
		})) satisfies Array<v.InferOutput<typeof PluginDependency>>
}
