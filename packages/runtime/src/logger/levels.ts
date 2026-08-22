import type { Context } from '@pluxel/core'
import {
	parsePluginLogPolicySnapshot,
	serializePluginLogPolicySnapshot,
	type PluginLogPolicyStore,
} from './policy'

type PersistenceNamespace = {
	getText(key: string): Promise<string | undefined>
	put(key: string, value: string, options?: { atomic?: boolean }): Promise<void>
}

type PersistenceLike = {
	namespace(name: string): PersistenceNamespace
}

function persistence(ctx: Context): PersistenceLike | undefined {
	const value = (ctx.root as unknown as { persistence?: unknown }).persistence
	if (!value || typeof value !== 'object') return undefined
	if (typeof (value as PersistenceLike).namespace !== 'function') return undefined
	return value as PersistenceLike
}

function policyKey(profile: string): string {
	const safe = String(profile || 'default').replaceAll(/[^A-Za-z0-9_.-]/g, '_') || 'default'
	return `plugin-policy/${safe}.json`
}

export function createContextPluginLogPolicyStore(ctx: Context): PluginLogPolicyStore | undefined {
	const store = persistence(ctx)
	if (!store) return undefined
	const namespace = store.namespace('logger')
	return {
		async load(profile) {
			const raw = await namespace.getText(policyKey(profile))
			if (raw === undefined) return undefined
			return parsePluginLogPolicySnapshot(raw)
		},
		async save(profile, snapshot) {
			await namespace.put(policyKey(profile), serializePluginLogPolicySnapshot(snapshot), {
				atomic: true,
			})
		},
	}
}
