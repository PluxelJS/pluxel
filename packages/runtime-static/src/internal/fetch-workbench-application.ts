import type { PluginConstructor } from '@pluxel/core'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { runStaticFetchApplication, type StaticFetchApplicationOptions } from './fetch-application'
import type { StaticRuntime, StaticRuntimeApplication, StaticRuntimeBindings } from '../types'

export function runStaticFetchWorkbenchApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: Omit<StaticFetchApplicationOptions<TBindings>, 'createWorkbenchBackend'> & {
		product?: ProductDescriptor | null
	},
): Promise<StaticRuntime> {
	return runStaticFetchApplication(application, { ...options, createWorkbenchBackend })
}
