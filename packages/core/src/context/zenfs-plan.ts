import { nativeProxyDispatcherFactory } from '../http/node-proxy'
import { snapshotZenFsCoreFacilitiesConfig } from '../internal/zenfs'
import type { CoreFacilitiesConfig, CoreHostConfig, RootContext } from './Context'
import { assertCoreConfigObject } from './core-config-object'
import type { PreparedCoreFacilities } from './core-facilities'
import { createCoreContextHostWithFacilities, type CoreContextPlanConfig } from './core-plan'

export function snapshotCoreFacilitiesConfig(
	input: CoreFacilitiesConfig = {},
): PreparedCoreFacilities {
	return snapshotZenFsCoreFacilitiesConfig(input, nativeProxyDispatcherFactory)
}

/** Prepare a direct Core plan with its original per-root ZenFS defaults. */
export function createCoreContextHost(
	config: CoreHostConfig & CoreContextPlanConfig = {},
	preparedFacilities?: PreparedCoreFacilities,
) {
	assertCoreConfigObject(config, '[core] Host configuration')
	const {
		name,
		execution,
		executionBinding,
		createConfigService,
		createLifecycleHooks,
		services,
		...facilities
	} = config
	if (preparedFacilities !== undefined && Object.keys(facilities).length > 0)
		throw new TypeError('[core] Core facilities must be supplied once')
	return createCoreContextHostWithFacilities(
		{ name, execution, executionBinding, createConfigService, createLifecycleHooks, services },
		preparedFacilities === undefined
			? snapshotCoreFacilitiesConfig(facilities)
			: preparedFacilities,
	)
}

export function createCoreRootContext(config: CoreHostConfig = {}): RootContext {
	return createCoreContextHost(config).createRoot()
}
