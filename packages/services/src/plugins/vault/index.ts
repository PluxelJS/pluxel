import type { Workbench } from '@pluxel/workbench'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { Vault } from '../../vault.ts'
import { VaultWorkbench } from './workbench.ts'

const WorkbenchRef = defineServiceRef<Workbench>()
/** Publishes UI only; privileged operations use the browser's authenticated management session. */
@Plugin({ displayName: 'Vault administration' })
export class VaultAdminPlugin extends BasePlugin {
	override init() {
		this.ctx.service(Vault)
		this.ctx.service(WorkbenchRef)?.publish(VaultWorkbench, { overview: () => new RpcTarget() })
	}
}
