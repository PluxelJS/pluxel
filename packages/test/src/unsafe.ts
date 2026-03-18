/**
 * Unsafe / low-level exports for specialized tests.
 *
 * DO NOT use these for normal plugin tests — prefer the high-level Host API from `@pluxel/test`.
 * These exist only for cases where you are explicitly testing decorator metadata / toolchain behavior.
 */

export {
	__registerConfigSchema__,
	__registerUsedFeature__,
	__registerUsedFeatures__,
	getRequiredPluginDependencies,
	pluginMethodDecorator,
	requirePluginDependency,
	resolvePluginDependency,
} from '@pluxel/core'
