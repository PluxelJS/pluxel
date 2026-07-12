export type ChatIdentity = {
	platform: string
	actorId: string
	username?: string
	displayName?: string
}
export type ChatUser = {
	id: string
	displayName: string | null
	identities: ChatIdentity[]
	createdAt: number
	updatedAt: number
}
export type PermissionEffect = 'allow' | 'deny'
export type PermissionDeclaration = {
	node: string
	description: string
	defaultEffect: PermissionEffect
}
export type PermissionGrant = { node: string; effect: PermissionEffect }
export type ChatRole = { id: string; name: string; rank: number; grants: PermissionGrant[] }
export type AccessState = {
	sequence: number
	users: ChatUser[]
	roles: ChatRole[]
	userRoles: Record<string, string[]>
	userGrants: Record<string, PermissionGrant[]>
}
export type AccessOverviewDoc = {
	id: 'overview'
	users: number
	identities: number
	roles: number
	permissions: number
	updatedAt: number
}

export function createEmptyAccessState(): AccessState {
	return { sequence: 1, users: [], roles: [], userRoles: {}, userGrants: {} }
}

export function identityKey(identity: Pick<ChatIdentity, 'platform' | 'actorId'>): string {
	return `${identity.platform}\u0000${identity.actorId}`
}
