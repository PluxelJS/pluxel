export const FEATURE_CONFIG_INJECTOR = '__injectConfigsFromHostPlugin' as const

export type FeatureConfigInjectionHost = {
	[FEATURE_CONFIG_INJECTOR]?: () => void
}

export function callFeatureConfigInjector(target: unknown): void {
	if (target === null || target === undefined) return
	const injector = (target as FeatureConfigInjectionHost)[FEATURE_CONFIG_INJECTOR]
	if (typeof injector === 'function') injector.call(target)
}
