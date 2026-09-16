import type { PluginConstructor } from '@pluxel/core'
import { createWorkbenchBackend } from '../../internal-static.ts'
import type { ProductDescriptor } from '../../product.ts'
import {
	runStaticFetchApplication,
	type StaticFetchApplicationOptions,
} from './fetch-application.ts'
import type { Runtime, RuntimeApplication, RuntimeBindings } from '../types.ts'

export function runStaticFetchWorkbenchApplication<
	TBindings extends RuntimeBindings = RuntimeBindings,
>(
	application: RuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: Omit<StaticFetchApplicationOptions<TBindings>, 'createWorkbenchBackend'> & {
		product?: ProductDescriptor | null
	},
): Promise<Runtime> {
	return runStaticFetchApplication(application, { ...options, createWorkbenchBackend })
}
