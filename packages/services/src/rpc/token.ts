import { defineContextCapability, type ContextCapability } from '@pluxel/core/host'
import type { RpcService } from './service'

export const Rpc: ContextCapability<RpcService> = defineContextCapability<RpcService>(
	'services.rpc',
	{ access: 'all', property: 'rpc' },
)

declare module '@pluxel/core' {
	interface ContextServices {
		readonly rpc: RpcService
	}
}
