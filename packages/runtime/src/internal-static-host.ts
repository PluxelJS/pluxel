export {
	isWorkbenchEnabled,
	matchesWorkbenchUiBasePath,
	resolveWorkbenchUiBasePath,
} from './workbench-config'
export { isRuntimeManagementEnabled, resolveRuntimePlanePlan } from './runtime-plane'
export { createRuntimeRootContext, prepareRuntimeRootContext } from './context/runtime-plan'
export type { RuntimeHostConfig } from './context/runtime-contract'

/** @internal Retains only structural union members with no properties outside the expected member. */
export type ExactConfigShape<Actual, Expected> = Actual extends unknown
	? Expected extends unknown
		? Actual extends Expected
			? Exclude<keyof Actual, keyof Expected> extends never
				? Actual
				: never
			: never
		: never
	: never

/** @internal Rejects an exact closed sub-configuration while leaving an absent property untouched. */
export type ExactConfigProperty<
	Actual,
	Key extends PropertyKey,
	Expected,
> = Key extends keyof Actual
	? [Actual[Key]] extends [ExactConfigShape<Actual[Key], Expected>]
		? Actual
		: never
	: Actual

export { isPluginAutoStartEnabled, setPluginAutoStart } from './services/RuntimeStateHelpers'
export type { RuntimePluginSource, RuntimeRouteCapabilities } from './runtime/capabilities'
export { createContextPluginLogPolicyStore } from './logger/levels'
export { readHostProduct } from './product-internal'
export {
	createRuntimeLogging,
	bindContextRuntimeLogging,
	type RuntimeLogging,
	type RuntimeLoggingInput,
} from './logger/logging'
