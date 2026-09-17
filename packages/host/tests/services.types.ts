import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { createHost, defineHostService } from '../src/index'

/** Compile-only contract: declaration tuples reject provable duplicate properties. */
export function checkHostServiceTypes() {
	const Provider = defineContextCapability<number>('typecheck.provider')
	const provider = defineHostService({
		name: 'provider',
		capabilities: [installRootCapability(Provider, { property: 'provider', create: () => 1 })],
	})
	// @ts-expect-error A tuple with duplicate projected properties is rejected before runtime.
	void createHost({ plugins: [], services: [provider, provider] })
}
