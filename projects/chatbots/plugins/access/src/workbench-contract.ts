import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { jsonObjectSchema } from '@repo/chatbots-workbench-support/wire-schema'
import type {
	AccessOverviewDoc,
	ChatRole,
	ChatUser,
	PermissionDeclaration,
	PermissionGrant,
} from './model.ts'

export type UserAccess = { roles: string[]; grants: PermissionGrant[] }

export interface ChatAccessCommands {
	listUsers(): ChatUser[]
	listPermissions(): PermissionDeclaration[]
	getUserAccess(userId: string): UserAccess
	setUserGrant(userId: string, grant: PermissionGrant): UserAccess
	revokeUserGrant(userId: string, node: string): UserAccess
	upsertRole(role: ChatRole): ChatRole
	assignRole(userId: string, roleId: string): UserAccess
	revokeRole(userId: string, roleId: string): UserAccess
	deleteRole(roleId: string): { ok: true }
}

export const ChatAccessUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<ChatAccessCommands>(),
		overview: workbenchContract.liveQuery({
			row: jsonObjectSchema<AccessOverviewDoc>(),
			key: 'id',
		}),
		users: workbenchContract.liveQuery({ row: jsonObjectSchema<ChatUser>(), key: 'id' }),
		roles: workbenchContract.liveQuery({ row: jsonObjectSchema<ChatRole>(), key: 'id' }),
	},
	views: {
		Access: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 45,
					label: '用户与权限',
					icon: workbenchContract.icons.ShieldLock,
				}),
				workbenchContract.route('/access', {
					title: '用户与权限',
					icon: workbenchContract.icons.Users,
					order: 66,
				}),
			],
		},
	},
})
