import { getContextRuntimeLogging } from '@pluxel/logging/internal'
import type { Context } from '@pluxel/core'
import type { HostApplicationMeta } from '../product-contract'
import { describePluxelPlatform } from '../platform-host'
import {
	RUNTIME_MANAGEMENT_CAPABILITIES,
	RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
	type RuntimeMeta,
} from '../web/protocol'

/** Runtime-owned discovery projection for the optional management plane. */
export class RuntimeManagementService {
	constructor(
		private readonly root: Context,
		private readonly application: HostApplicationMeta,
		private readonly workbench = false,
	) {}

	describe(): RuntimeMeta {
		return Object.freeze({
			service: 'pluxel-runtime',
			ready: true,
			protocol: protocolDescriptor(
				'vaultAdmin' in this.root.root,
				getContextRuntimeLogging(this.root) !== undefined,
			),
			application: this.application,
			platform: describePluxelPlatform(),
			workbench: Object.freeze({ enabled: this.workbench }),
		})
	}
}

function protocolDescriptor(vault: boolean, logging: boolean): RuntimeMeta['protocol'] {
	return Object.freeze({
		name: 'pluxel.management',
		major: RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
		capabilities: Object.freeze(
			RUNTIME_MANAGEMENT_CAPABILITIES.filter(
				(capability) => (capability !== 'vault' || vault) && (capability !== 'logging' || logging),
			),
		),
	})
}
