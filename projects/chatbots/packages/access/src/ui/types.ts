import type {
	AccessOverviewDoc,
	ChatRole,
	ChatUser,
	PermissionDeclaration,
	PermissionGrant,
} from '../index.ts'

export type UserAccess = { roles: string[]; grants: PermissionGrant[] }
type MaybePromise<T> = T | Promise<T>

export type AccessUiApp = {
	rpc: {
		listPermissions(): MaybePromise<PermissionDeclaration[]>
		getUserAccess(userId: string): MaybePromise<UserAccess>
		setUserGrant(userId: string, grant: PermissionGrant): MaybePromise<UserAccess>
		revokeUserGrant(userId: string, node: string): MaybePromise<UserAccess>
		upsertRole(role: ChatRole): MaybePromise<ChatRole>
		assignRole(userId: string, roleId: string): MaybePromise<UserAccess>
		revokeRole(userId: string, roleId: string): MaybePromise<UserAccess>
		deleteRole(roleId: string): MaybePromise<{ ok: true }>
	}
	db: {
		useDocById(collection: 'overview', id: 'overview'): AccessOverviewDoc | undefined
		useList(collection: 'users'): ChatUser[]
		useList(collection: 'roles'): ChatRole[]
	}
}
