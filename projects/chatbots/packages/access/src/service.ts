import type { ChatMessage } from '@repo/chatbots-contracts'
import {
	identityKey,
	type AccessState,
	type ChatIdentity,
	type ChatRole,
	type ChatUser,
	type PermissionDeclaration,
	type PermissionGrant,
} from './model.ts'
import { decideGrants, normalizePermissionNode } from './policy.ts'

export type ChatAccessChange = {
	kind: 'state' | 'declarations'
	userIds?: readonly string[]
	removedUserIds?: readonly string[]
	roleIds?: readonly string[]
	removedRoleIds?: readonly string[]
}

/** Pure identity and authorization domain; no Context, persistence or management dependencies. */
export class ChatAccessDomain {
	private readonly usersById = new Map<string, ChatUser>()
	private readonly usersByIdentity = new Map<string, ChatUser>()
	private readonly rolesById = new Map<string, ChatRole>()
	private readonly rolePlans = new Map<string, readonly ChatRole[]>()
	private readonly declarations = new Map<string, PermissionDeclaration>()
	private readonly declarationRefs = new Map<string, number>()
	private readonly linkCodes = new Map<string, { userId: string; expiresAt: number }>()
	private readonly linkFailures = new Map<string, { count: number; resetAt: number }>()
	private declarationPlan?: PermissionDeclaration[]

	constructor(
		private readonly state: AccessState,
		private readonly onChange: (change: ChatAccessChange) => void,
	) {
		for (const user of state.users) {
			this.usersById.set(user.id, user)
			for (const identity of user.identities) this.usersByIdentity.set(identityKey(identity), user)
		}
		for (const role of state.roles) this.rolesById.set(role.id, role)
	}

	resolveMessage(message: ChatMessage): ChatUser {
		const identity: ChatIdentity = {
			platform: message.platform,
			actorId: message.actor.id,
			username: message.actor.username,
			displayName: message.actor.displayName,
		}
		const key = identityKey(identity)
		const existing = this.usersByIdentity.get(key)
		if (existing) {
			const stored = existing.identities.find((item) => identityKey(item) === key)!
			if (stored.username !== identity.username || stored.displayName !== identity.displayName) {
				Object.assign(stored, identity)
				existing.displayName = identity.displayName ?? identity.username ?? existing.displayName
				existing.updatedAt = Date.now()
				this.onChange({ kind: 'state', userIds: [existing.id] })
			}
			return existing
		}
		const now = Date.now()
		const user: ChatUser = {
			id: `user-${this.state.sequence++}`,
			displayName: identity.displayName ?? identity.username ?? null,
			identities: [identity],
			createdAt: now,
			updatedAt: now,
		}
		this.state.users.push(user)
		this.usersById.set(user.id, user)
		this.usersByIdentity.set(key, user)
		this.onChange({ kind: 'state', userIds: [user.id] })
		return user
	}

	listUsers(): ChatUser[] {
		return structuredClone(this.state.users)
	}
	listRoles(): ChatRole[] {
		return structuredClone(this.state.roles)
	}
	getUser(id: string): ChatUser | undefined {
		const user = this.usersById.get(id)
		return user ? structuredClone(user) : undefined
	}
	getRole(id: string): ChatRole | undefined {
		const role = this.rolesById.get(id)
		return role ? structuredClone(role) : undefined
	}
	overview(): { users: number; identities: number; roles: number; permissions: number } {
		return {
			users: this.usersById.size,
			identities: this.usersByIdentity.size,
			roles: this.rolesById.size,
			permissions: this.declarations.size,
		}
	}
	listPermissions(): PermissionDeclaration[] {
		return structuredClone(
			(this.declarationPlan ??= [...this.declarations.values()].sort((a, b) =>
				a.node.localeCompare(b.node),
			)),
		)
	}
	serialize(): string {
		return JSON.stringify(this.state, null, 2)
	}

	createLinkCode(userId: string, ttlMs = 5 * 60_000): { code: string; expiresAt: number } {
		if (!this.usersById.has(userId)) throw new Error(`Unknown user: ${userId}`)
		if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000)
			throw new Error('Link code TTL must be between 1 second and 30 minutes')
		this.pruneLinkCodes()
		for (const [existingCode, link] of this.linkCodes)
			if (link.userId === userId) this.linkCodes.delete(existingCode)
		let code = ''
		do code = randomLinkCode()
		while (this.linkCodes.has(code))
		const expiresAt = Date.now() + ttlMs
		this.linkCodes.set(code, { userId, expiresAt })
		return { code, expiresAt }
	}

	consumeLinkCode(currentUserId: string, code: string): ChatUser {
		this.pruneLinkCodes()
		this.assertLinkAttempts(currentUserId)
		const link = this.linkCodes.get(code.trim())
		if (!link) {
			this.recordLinkFailure(currentUserId)
			throw new Error('关联码无效或已过期。')
		}
		this.linkCodes.delete(code.trim())
		this.linkFailures.delete(currentUserId)
		const target = this.usersById.get(link.userId)
		const source = this.usersById.get(currentUserId)
		if (!target || !source) throw new Error('关联用户不存在。')
		if (target === source) return structuredClone(target)
		for (const identity of source.identities) {
			if (!target.identities.some((item) => identityKey(item) === identityKey(identity)))
				target.identities.push(identity)
			this.usersByIdentity.set(identityKey(identity), target)
		}
		target.updatedAt = Date.now()
		this.state.userRoles[target.id] = [
			...new Set([
				...(this.state.userRoles[target.id] ?? []),
				...(this.state.userRoles[source.id] ?? []),
			]),
		]
		const grants = [...(this.state.userGrants[target.id] ?? [])]
		for (const grant of this.state.userGrants[source.id] ?? [])
			if (!grants.some((item) => item.node === grant.node)) grants.push(grant)
		this.state.userGrants[target.id] = grants
		delete this.state.userRoles[source.id]
		delete this.state.userGrants[source.id]
		this.rolePlans.delete(target.id)
		this.rolePlans.delete(source.id)
		this.state.users.splice(this.state.users.indexOf(source), 1)
		this.usersById.delete(source.id)
		this.onChange({
			kind: 'state',
			userIds: [target.id],
			removedUserIds: [source.id],
		})
		return structuredClone(target)
	}

	declare(input: PermissionDeclaration): () => void {
		const declaration = { ...input, node: normalizePermissionNode(input.node) }
		const existing = this.declarations.get(declaration.node)
		if (existing && existing.defaultEffect !== declaration.defaultEffect)
			throw new Error(`Permission declaration conflicts: ${declaration.node}`)
		if (existing) {
			this.declarationRefs.set(
				declaration.node,
				(this.declarationRefs.get(declaration.node) ?? 1) + 1,
			)
			return this.declarationDisposer(declaration.node)
		}
		this.declarations.set(declaration.node, declaration)
		this.declarationRefs.set(declaration.node, 1)
		this.declarationPlan = undefined
		this.onChange({ kind: 'declarations' })
		return this.declarationDisposer(declaration.node)
	}

	authorize(userId: string, nodeInput: string): boolean {
		const node = normalizePermissionNode(nodeInput)
		if (!this.declarations.has(node)) return false
		const userDecision = decideGrants(this.state.userGrants[userId] ?? [], node)
		if (userDecision) return userDecision === 'allow'
		const roles = this.getRolePlan(userId)
		for (const role of roles) {
			const decision = decideGrants(role.grants, node)
			if (decision) return decision === 'allow'
		}
		return this.declarations.get(node)!.defaultEffect === 'allow'
	}

	setUserGrant(userId: string, grant: PermissionGrant): void {
		if (!this.usersById.has(userId)) throw new Error(`Unknown user: ${userId}`)
		const normalized = { ...grant, node: normalizePermissionNode(grant.node) }
		if (!this.declarations.has(normalized.node) && !normalized.node.endsWith('.*'))
			throw new Error(`Permission is not declared: ${normalized.node}`)
		const grants = (this.state.userGrants[userId] ??= [])
		const index = grants.findIndex((item) => item.node === normalized.node)
		if (index < 0) grants.push(normalized)
		else grants[index] = normalized
		this.onChange({ kind: 'state' })
	}

	revokeUserGrant(userId: string, nodeInput: string): void {
		const node = normalizePermissionNode(nodeInput)
		const current = this.state.userGrants[userId] ?? []
		const next = current.filter((item) => item.node !== node)
		if (next.length === current.length) return
		this.state.userGrants[userId] = next
		this.onChange({ kind: 'state' })
	}

	upsertRole(input: ChatRole): ChatRole {
		const role: ChatRole = {
			...input,
			id: input.id.trim(),
			name: input.name.trim(),
			rank: Math.floor(input.rank),
			grants: input.grants.map((grant) => ({
				...grant,
				node: normalizePermissionNode(grant.node),
			})),
		}
		if (!role.id || !role.name) throw new Error('Role id and name are required')
		const index = this.state.roles.findIndex((item) => item.id === role.id)
		if (index < 0) this.state.roles.push(role)
		else this.state.roles[index] = role
		this.rolesById.set(role.id, role)
		this.rolePlans.clear()
		this.onChange({ kind: 'state', roleIds: [role.id] })
		return structuredClone(role)
	}

	assignRole(userId: string, roleId: string): void {
		if (!this.usersById.has(userId)) throw new Error(`Unknown user: ${userId}`)
		if (!this.rolesById.has(roleId)) throw new Error(`Unknown role: ${roleId}`)
		const roles = (this.state.userRoles[userId] ??= [])
		if (!roles.includes(roleId)) {
			roles.push(roleId)
			this.rolePlans.delete(userId)
			this.onChange({ kind: 'state' })
		}
	}

	revokeRole(userId: string, roleId: string): void {
		const roles = this.state.userRoles[userId] ?? []
		const next = roles.filter((id) => id !== roleId)
		if (next.length === roles.length) return
		this.state.userRoles[userId] = next
		this.rolePlans.delete(userId)
		this.onChange({ kind: 'state' })
	}

	deleteRole(roleId: string): void {
		const index = this.state.roles.findIndex((role) => role.id === roleId)
		if (index < 0) return
		this.state.roles.splice(index, 1)
		this.rolesById.delete(roleId)
		for (const [userId, roles] of Object.entries(this.state.userRoles))
			this.state.userRoles[userId] = roles.filter((id) => id !== roleId)
		this.rolePlans.clear()
		this.onChange({ kind: 'state', removedRoleIds: [roleId] })
	}

	accessForUser(userId: string) {
		return {
			roles: [...(this.state.userRoles[userId] ?? [])],
			grants: structuredClone(this.state.userGrants[userId] ?? []),
		}
	}

	private pruneLinkCodes(): void {
		const now = Date.now()
		for (const [code, link] of this.linkCodes)
			if (link.expiresAt <= now) this.linkCodes.delete(code)
	}
	private assertLinkAttempts(userId: string): void {
		const failure = this.linkFailures.get(userId)
		if (!failure) return
		if (failure.resetAt <= Date.now()) {
			this.linkFailures.delete(userId)
			return
		}
		if (failure.count >= 8) throw new Error('关联尝试过多，请稍后再试。')
	}
	private recordLinkFailure(userId: string): void {
		const current = this.linkFailures.get(userId)
		this.linkFailures.set(userId, {
			count: (current?.count ?? 0) + 1,
			resetAt: current?.resetAt ?? Date.now() + 5 * 60_000,
		})
	}
	private getRolePlan(userId: string): readonly ChatRole[] {
		let plan = this.rolePlans.get(userId)
		if (!plan) {
			plan = (this.state.userRoles[userId] ?? [])
				.map((id) => this.rolesById.get(id))
				.filter((role): role is ChatRole => Boolean(role))
				.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
			this.rolePlans.set(userId, plan)
		}
		return plan
	}
	private declarationDisposer(node: string): () => void {
		let active = true
		return () => {
			if (!active) return
			active = false
			this.releaseDeclaration(node)
		}
	}
	private releaseDeclaration(node: string): void {
		const refs = this.declarationRefs.get(node) ?? 0
		if (refs > 1) {
			this.declarationRefs.set(node, refs - 1)
			return
		}
		this.declarationRefs.delete(node)
		if (this.declarations.delete(node)) {
			this.declarationPlan = undefined
			this.onChange({ kind: 'declarations' })
		}
	}
}

function randomLinkCode(): string {
	const bytes = new Uint32Array(1)
	globalThis.crypto.getRandomValues(bytes)
	return String(100_000 + (bytes[0]! % 900_000))
}
