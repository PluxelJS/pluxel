import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { ChatRole, PermissionGrant } from './model.ts'
import type { ChatAccessPlugin } from './plugin.ts'

export class ChatAccessRpc extends RpcTarget {
	constructor(private readonly access: ChatAccessPlugin) {
		super()
	}
	listUsers() {
		return this.access.listUsers()
	}
	listPermissions() {
		return this.access.listPermissions()
	}
	getUserAccess(userId: string) {
		return this.access.accessForUser(userId)
	}
	setUserGrant(userId: string, grant: PermissionGrant) {
		this.access.setUserGrant(userId, grant)
		return this.access.accessForUser(userId)
	}
	revokeUserGrant(userId: string, node: string) {
		this.access.revokeUserGrant(userId, node)
		return this.access.accessForUser(userId)
	}
	upsertRole(role: ChatRole) {
		return this.access.upsertRole(role)
	}
	assignRole(userId: string, roleId: string) {
		this.access.assignRole(userId, roleId)
		return this.access.accessForUser(userId)
	}
	revokeRole(userId: string, roleId: string) {
		this.access.revokeRole(userId, roleId)
		return this.access.accessForUser(userId)
	}
	deleteRole(roleId: string) {
		this.access.deleteRole(roleId)
		return { ok: true as const }
	}
}
