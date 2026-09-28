import {
	parsePluginLogPolicySnapshot,
	serializePluginLogPolicySnapshot,
	type PluginLogPolicyStore,
} from './policy'
export type PluginLogPolicyStorage = Readonly<{
	getText(key: string): Promise<string | undefined>
	put(key: string, value: string, options?: { atomic?: boolean }): Promise<void>
}>
/** Borrow a namespace; logging owns pending policy writes, never the backend. */
export function createPluginLogPolicyStore(
	namespace: PluginLogPolicyStorage,
): PluginLogPolicyStore {
	const key = (profile: string) =>
		`plugin-policy/${String(profile || 'default').replaceAll(/[^A-Za-z0-9_.-]/g, '_') || 'default'}.json`
	return {
		async load(profile) {
			const raw = await namespace.getText(key(profile))
			return raw === undefined ? undefined : parsePluginLogPolicySnapshot(raw)
		},
		async save(profile, snapshot) {
			await namespace.put(key(profile), serializePluginLogPolicySnapshot(snapshot), {
				atomic: true,
			})
		},
	}
}
