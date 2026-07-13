import {
	identityKey,
	type AccessState,
	type ChatIdentity,
	type ChatRole,
	type ChatUser,
	type PermissionGrant,
} from './model.ts'

/** Validates persisted state before it enters the access domain. */
export function parseAccessState(input: unknown): AccessState {
	const root = record(input, 'access state')
	const sequence = positiveInteger(root.sequence, 'access state sequence')
	const users = array(root.users, 'access state users').map((value, index) =>
		readUser(value, `access state users[${index}]`),
	)
	const roles = array(root.roles, 'access state roles').map((value, index) =>
		readRole(value, `access state roles[${index}]`),
	)

	const userIds = unique(users, (user) => user.id, 'user id')
	const roleIds = unique(roles, (role) => role.id, 'role id')
	unique(
		users.flatMap((user) => user.identities),
		identityKey,
		'platform identity',
	)
	const highestGeneratedId = users.reduce((highest, user) => {
		const match = /^user-(\d+)$/.exec(user.id)
		return Math.max(highest, match ? Number(match[1]) : 0)
	}, 0)
	if (sequence <= highestGeneratedId)
		throw new Error('Access state sequence must be greater than every generated user id')

	return {
		sequence,
		users,
		roles,
		userRoles: readUserRoles(root.userRoles, userIds, roleIds),
		userGrants: readUserGrants(root.userGrants, userIds),
	}
}

function readUser(value: unknown, path: string): ChatUser {
	const source = record(value, path)
	const identities = array(source.identities, `${path}.identities`).map((identity, index) =>
		readIdentity(identity, `${path}.identities[${index}]`),
	)
	if (identities.length === 0) throw new Error(`${path}.identities must not be empty`)
	return {
		id: nonEmptyString(source.id, `${path}.id`),
		displayName: nullableString(source.displayName, `${path}.displayName`),
		identities,
		createdAt: finiteNumber(source.createdAt, `${path}.createdAt`),
		updatedAt: finiteNumber(source.updatedAt, `${path}.updatedAt`),
	}
}

function readIdentity(value: unknown, path: string): ChatIdentity {
	const source = record(value, path)
	return {
		platform: nonEmptyString(source.platform, `${path}.platform`),
		actorId: nonEmptyString(source.actorId, `${path}.actorId`),
		...(source.username === undefined
			? {}
			: { username: string(source.username, `${path}.username`) }),
		...(source.displayName === undefined
			? {}
			: { displayName: string(source.displayName, `${path}.displayName`) }),
	}
}

function readRole(value: unknown, path: string): ChatRole {
	const source = record(value, path)
	return {
		id: nonEmptyString(source.id, `${path}.id`),
		name: nonEmptyString(source.name, `${path}.name`),
		rank: integer(source.rank, `${path}.rank`),
		grants: readGrants(source.grants, `${path}.grants`),
	}
}

function readGrants(value: unknown, path: string): PermissionGrant[] {
	const grants = array(value, path).map((grant, index): PermissionGrant => {
		const source = record(grant, `${path}[${index}]`)
		const node = nonEmptyString(source.node, `${path}[${index}].node`)
		if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\.\*)?$/.test(node))
			throw new Error(`Invalid permission node in ${path}: ${node}`)
		const effect = source.effect
		if (effect !== 'allow' && effect !== 'deny')
			throw new Error(`${path}[${index}].effect must be allow or deny`)
		return { node, effect }
	})
	unique(grants, (grant) => grant.node, `permission grant in ${path}`)
	return grants
}

function readUserRoles(
	value: unknown,
	userIds: ReadonlySet<string>,
	roleIds: ReadonlySet<string>,
): AccessState['userRoles'] {
	const assignments: AccessState['userRoles'] = {}
	for (const [userId, rawRoles] of Object.entries(record(value, 'access state userRoles'))) {
		if (!userIds.has(userId)) throw new Error(`Access state references unknown user: ${userId}`)
		const roles = array(rawRoles, `access state userRoles.${userId}`).map((role, index) =>
			nonEmptyString(role, `access state userRoles.${userId}[${index}]`),
		)
		unique(roles, (role) => role, `role assignment for ${userId}`)
		for (const roleId of roles)
			if (!roleIds.has(roleId)) throw new Error(`Access state references unknown role: ${roleId}`)
		assignments[userId] = roles
	}
	return assignments
}

function readUserGrants(value: unknown, userIds: ReadonlySet<string>): AccessState['userGrants'] {
	const assignments: AccessState['userGrants'] = {}
	for (const [userId, rawGrants] of Object.entries(record(value, 'access state userGrants'))) {
		if (!userIds.has(userId)) throw new Error(`Access state references unknown user: ${userId}`)
		assignments[userId] = readGrants(rawGrants, `access state userGrants.${userId}`)
	}
	return assignments
}

function unique<Value>(
	values: readonly Value[],
	key: (value: Value) => string,
	label: string,
): ReadonlySet<string> {
	const keys = new Set<string>()
	for (const value of values) {
		const id = key(value)
		if (keys.has(id)) throw new Error(`Duplicate ${label}: ${id}`)
		keys.add(id)
	}
	return keys
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${path} must be an object`)
	return value as Record<string, unknown>
}

function array(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
	return value
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`${path} must be a non-empty string`)
	return value
}

function nullableString(value: unknown, path: string): string | null {
	if (value === null) return null
	if (typeof value === 'string') return value
	throw new Error(`${path} must be a string or null`)
}

function string(value: unknown, path: string): string {
	if (typeof value !== 'string') throw new Error(`${path} must be a string`)
	return value
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`${path} must be a finite number`)
	return value
}

function integer(value: unknown, path: string): number {
	const number = finiteNumber(value, path)
	if (!Number.isInteger(number)) throw new Error(`${path} must be an integer`)
	return number
}

function positiveInteger(value: unknown, path: string): number {
	const number = integer(value, path)
	if (number < 1) throw new Error(`${path} must be positive`)
	return number
}
