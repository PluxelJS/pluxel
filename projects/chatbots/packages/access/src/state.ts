import {
	createEmptyAccessState,
	identityKey,
	type AccessState,
	type ChatIdentity,
	type ChatRole,
	type ChatUser,
	type PermissionGrant,
} from './model.ts'

/** Repairs persisted JSON at the boundary so the domain never operates on partial shapes. */
export function normalizeAccessState(input: unknown): AccessState {
	if (!isRecord(input)) return createEmptyAccessState()
	const users: ChatUser[] = []
	const userIds = new Set<string>()
	const identityIds = new Set<string>()
	for (const raw of array(input.users)) {
		if (!isRecord(raw) || typeof raw.id !== 'string' || userIds.has(raw.id)) continue
		const identities = array(raw.identities)
			.map(readIdentity)
			.filter((value): value is ChatIdentity => Boolean(value))
			.filter((identity) => {
				const key = identityKey(identity)
				if (identityIds.has(key)) return false
				identityIds.add(key)
				return true
			})
		if (identities.length === 0) continue
		userIds.add(raw.id)
		users.push({
			id: raw.id,
			displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
			identities,
			createdAt: finiteNumber(raw.createdAt) ?? Date.now(),
			updatedAt: finiteNumber(raw.updatedAt) ?? Date.now(),
		})
	}

	const roles: ChatRole[] = []
	const roleIds = new Set<string>()
	for (const raw of array(input.roles)) {
		if (
			!isRecord(raw) ||
			typeof raw.id !== 'string' ||
			!raw.id ||
			roleIds.has(raw.id) ||
			typeof raw.name !== 'string'
		)
			continue
		roleIds.add(raw.id)
		roles.push({
			id: raw.id,
			name: raw.name,
			rank: Math.floor(finiteNumber(raw.rank) ?? 0),
			grants: array(raw.grants)
				.map(readGrant)
				.filter((value): value is PermissionGrant => Boolean(value)),
		})
	}

	const userRoles: AccessState['userRoles'] = {}
	for (const [userId, assigned] of recordEntries(input.userRoles)) {
		if (!userIds.has(userId)) continue
		userRoles[userId] = [
			...new Set(
				array(assigned).filter((id): id is string => typeof id === 'string' && roleIds.has(id)),
			),
		]
	}
	const userGrants: AccessState['userGrants'] = {}
	for (const [userId, rawGrants] of recordEntries(input.userGrants)) {
		if (!userIds.has(userId)) continue
		userGrants[userId] = array(rawGrants)
			.map(readGrant)
			.filter((value): value is PermissionGrant => Boolean(value))
	}

	const storedSequence = finiteNumber(input.sequence)
	const highestGeneratedId = users.reduce((highest, user) => {
		const match = /^user-(\d+)$/.exec(user.id)
		return Math.max(highest, match ? Number(match[1]) : 0)
	}, 0)
	return {
		sequence: Math.max(1, Math.floor(storedSequence ?? 1), highestGeneratedId + 1),
		users,
		roles,
		userRoles,
		userGrants,
	}
}

function readIdentity(value: unknown): ChatIdentity | undefined {
	if (
		!isRecord(value) ||
		typeof (value.platform ?? value.transport) !== 'string' ||
		!(value.platform ?? value.transport) ||
		typeof value.actorId !== 'string' ||
		!value.actorId
	)
		return undefined
	return {
		platform: (value.platform ?? value.transport) as string,
		actorId: value.actorId,
		...(typeof value.username === 'string' ? { username: value.username } : {}),
		...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
	}
}

function readGrant(value: unknown): PermissionGrant | undefined {
	if (
		!isRecord(value) ||
		typeof value.node !== 'string' ||
		!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\.\*)?$/.test(value.node) ||
		(value.effect !== 'allow' && value.effect !== 'deny')
	)
		return undefined
	return { node: value.node, effect: value.effect }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}
function recordEntries(value: unknown): Array<[string, unknown]> {
	return isRecord(value) ? Object.entries(value) : []
}
function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
