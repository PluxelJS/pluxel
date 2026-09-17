import { BasePlugin, Plugin } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { Vault } from '@pluxel/services/vault'
import { VaultWorkbench } from './workbench.ts'

/** Publishes UI only; privileged operations use the browser's authenticated management session. */
@Plugin({ displayName: 'Vault administration' })
export class VaultAdminPlugin extends BasePlugin {
	override init() {
		this.ctx.require(Vault)
		this.ctx.workbench?.publish(VaultWorkbench, { overview: () => new RpcTarget() })
	}
}
