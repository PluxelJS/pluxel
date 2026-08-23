import type { Context } from '@pluxel/core'
import type { HostApplicationMeta } from '../product-contract'
import {
	RUNTIME_MANAGEMENT_CAPABILITIES,
	RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
	type RuntimeMetaV1,
} from '../web/protocol'
import { RUNTIME_TRANSPORT_PATHS } from '../web/paths'
const BASE_MANAGEMENT_CAPABILITIES = Object.freeze(
	RUNTIME_MANAGEMENT_CAPABILITIES.filter((capability) => capability !== 'vault'),
)

/** Runtime-owned discovery projection for the optional management plane. */
export class RuntimeManagementService {
	constructor(
		private readonly root: Context,
		private readonly application: HostApplicationMeta,
	) {}

	describe(): RuntimeMetaV1 {
		return Object.freeze({
			service: 'pluxel-runtime',
			ready: true,
			protocol: protocolDescriptor(this.root.root.vaultAdmin !== undefined),
			application: this.application,
			workbench: Object.freeze({ enabled: this.root.workbench !== undefined }),
			transport: Object.freeze({ rpc: RUNTIME_TRANSPORT_PATHS.rpc }),
		})
	}
}

function protocolDescriptor(vault: boolean): RuntimeMetaV1['protocol'] {
	return Object.freeze({
		name: 'pluxel.management',
		major: RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
		capabilities: vault ? RUNTIME_MANAGEMENT_CAPABILITIES : BASE_MANAGEMENT_CAPABILITIES,
	})
}
