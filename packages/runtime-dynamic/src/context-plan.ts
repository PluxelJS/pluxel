import {
	defineContextCapability,
	installRootCapability,
	resolveContextCapability,
} from '@pluxel/core/internal'
import type { Context, RootCapabilityInstallation, RootContext } from '@pluxel/core'
import { LoaderService } from './loader/LoaderService'
import { ScanService } from './scan/ScanService'

const LOADER_CAPABILITY = defineContextCapability<LoaderService>('runtime-dynamic.loader')
const SCAN_CAPABILITY = defineContextCapability<ScanService>('runtime-dynamic.scan')

/** Dynamic-route catalog and lifecycle coordinator. Internal to this package and its tests. */
export function requireLoaderService(ctx: Context): LoaderService {
	return resolveContextCapability(ctx, LOADER_CAPABILITY)
}

/** Dynamic-route workspace scanner. Internal to this package and its tests. */
export function requireScanService(ctx: Context): ScanService {
	return resolveContextCapability(ctx, SCAN_CAPABILITY)
}

/** Compile dynamic-route capabilities into the immutable host plan before root creation. */
export function createDynamicRouteContextCapabilities(): readonly RootCapabilityInstallation<
	unknown,
	undefined
>[] {
	return Object.freeze([
		installRootCapability(LOADER_CAPABILITY, {
			create: (root) => new LoaderService(root as RootContext),
		}),
		installRootCapability(SCAN_CAPABILITY, {
			create: (root) => new ScanService(root as RootContext),
		}),
	])
}
