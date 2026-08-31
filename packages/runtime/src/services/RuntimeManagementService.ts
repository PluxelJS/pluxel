import type { Context } from '@pluxel/core'
import type { HostApplicationMeta } from '../product-contract'
import { describePluxelPlatform } from '../environment'
import {
	RUNTIME_MANAGEMENT_CAPABILITIES,
	RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
	type RuntimeMeta,
} from '../web/protocol'
const BASE_MANAGEMENT_CAPABILITIES = Object.freeze(
	RUNTIME_MANAGEMENT_CAPABILITIES.filter((capability) => capability !== 'vault'),
)

/** Runtime-owned discovery projection for the optional management plane. */
export class RuntimeManagementService {
	constructor(
		private readonly root: Context,
		private readonly application: HostApplicationMeta,
	) {}

	describe(): RuntimeMeta {
		return Object.freeze({
			service: 'pluxel-runtime',
			ready: true,
			protocol: protocolDescriptor(this.root.root.vaultAdmin !== undefined),
			application: this.application,
			platform: describePluxelPlatform(),
			workbench: Object.freeze({ enabled: this.root.workbench !== undefined }),
		})
	}
}

function protocolDescriptor(vault: boolean): RuntimeMeta['protocol'] {
	return Object.freeze({
		name: 'pluxel.management',
		major: RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
		capabilities: vault ? RUNTIME_MANAGEMENT_CAPABILITIES : BASE_MANAGEMENT_CAPABILITIES,
	})
}
