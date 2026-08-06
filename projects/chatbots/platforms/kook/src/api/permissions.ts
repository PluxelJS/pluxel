/**
 * KOOK guild permission bits as their wire-level unsigned integer values.
 *
 * The values can be passed directly in `permissions`, `allow`, and `deny` masks. They are masks,
 * not bit indexes.
 */
export const KookPermission = Object.freeze({
	GUILD_ADMIN: 2 ** 0,
	GUILD_MANAGE: 2 ** 1,
	GUILD_LOG: 2 ** 2,
	GUILD_INVITE_CREATE: 2 ** 3,
	GUILD_INVITE_MANAGE: 2 ** 4,
	CHANNEL_MANAGE: 2 ** 5,
	GUILD_USER_KICK: 2 ** 6,
	GUILD_USER_BAN: 2 ** 7,
	GUILD_EMOJI_MANAGE: 2 ** 8,
	GUILD_USER_NAME_CHANGE: 2 ** 9,
	GUILD_ROLE_MANAGE: 2 ** 10,
	CHANNEL_VIEW: 2 ** 11,
	CHANNEL_MESSAGE: 2 ** 12,
	CHANNEL_MANAGE_MESSAGE: 2 ** 13,
	CHANNEL_UPLOAD: 2 ** 14,
	CHANNEL_VOICE_CONNECT: 2 ** 15,
	CHANNEL_VOICE_MANAGE: 2 ** 16,
	CHANNEL_MESSAGE_AT_ALL: 2 ** 17,
	CHANNEL_MESSAGE_REACTION_CREATE: 2 ** 18,
	CHANNEL_MESSAGE_REACTION_FOLLOW: 2 ** 19,
	CHANNEL_VOICE_CONNECT_PASSIVE: 2 ** 20,
	CHANNEL_VOICE_SPEAK_KEY_ONLY: 2 ** 21,
	CHANNEL_VOICE_SPEAK_FREE: 2 ** 22,
	CHANNEL_VOICE_SPEAK: 2 ** 23,
	GUILD_USER_DEAFEN: 2 ** 24,
	GUILD_USER_MUTE: 2 ** 25,
	GUILD_USER_NAME_CHANGE_OTHER: 2 ** 26,
	CHANNEL_VOICE_BGM: 2 ** 27,
	CHANNEL_SCREEN_SHARE: 2 ** 28,
	THREAD_REPLY: 2 ** 29,
	CHANNEL_RECORDING: 2 ** 30,
} as const)

export type KookPermission = (typeof KookPermission)[keyof typeof KookPermission]
export type KookPermissionOverwriteEffect = 'inherit' | 'allow' | 'deny'
export type KookPermissionOverwrite = Readonly<{ allow: number; deny: number }>
export type KookPermissionOverwriteInput = Readonly<{
	allow?: Iterable<KookPermission>
	deny?: Iterable<KookPermission>
}>

const knownPermissions = new Set<number>(Object.values(KookPermission))

/** Combines known KOOK permission values without JavaScript's signed 32-bit bitwise coercion. */
export function combineKookPermissions(permissions: Iterable<KookPermission>): number {
	let mask = 0n
	for (const permission of permissions) mask |= toPermissionBit(permission)
	return Number(mask)
}

/**
 * Tests one KOOK permission using platform semantics. `GUILD_ADMIN` satisfies every known bit.
 */
export function hasKookPermission(mask: number, permission: KookPermission): boolean {
	const value = toMask(mask, 'mask')
	const bit = toPermissionBit(permission)
	return contains(value, BigInt(KookPermission.GUILD_ADMIN)) || contains(value, bit)
}

/** Tests whether every requested permission is present. An empty request is true. */
export function hasAllKookPermissions(
	mask: number,
	permissions: Iterable<KookPermission>,
): boolean {
	const value = toMask(mask, 'mask')
	const requested = [...permissions].map(toPermissionBit)
	if (requested.length === 0) return true
	if (contains(value, BigInt(KookPermission.GUILD_ADMIN))) return true
	return requested.every((permission) => contains(value, permission))
}

/** Tests whether at least one requested permission is present. An empty request is false. */
export function hasAnyKookPermission(
	mask: number,
	permissions: Iterable<KookPermission>,
): boolean {
	const value = toMask(mask, 'mask')
	const requested = [...permissions].map(toPermissionBit)
	if (requested.length === 0) return false
	if (contains(value, BigInt(KookPermission.GUILD_ADMIN))) return true
	return requested.some((permission) => contains(value, permission))
}

/** Creates one immutable, disjoint KOOK channel allow/deny overwrite. */
export function createKookPermissionOverwrite(
	input: KookPermissionOverwriteInput = {},
): KookPermissionOverwrite {
	const allow = combineKookPermissions(input.allow ?? [])
	const deny = combineKookPermissions(input.deny ?? [])
	return freezeOverwrite(allow, deny)
}

/** Returns the explicit tri-state effect for one permission in an overwrite. */
export function getKookPermissionOverwriteEffect(
	overwrite: KookPermissionOverwrite,
	permission: KookPermission,
): KookPermissionOverwriteEffect {
	const { allow, deny } = validateOverwrite(overwrite)
	const bit = toPermissionBit(permission)
	if (contains(allow, bit)) return 'allow'
	if (contains(deny, bit)) return 'deny'
	return 'inherit'
}

/**
 * Returns a new overwrite after assigning the same effect to the selected permissions.
 * Unselected bits, including unknown future KOOK bits, are preserved.
 */
export function setKookPermissionOverwrite(
	overwrite: KookPermissionOverwrite,
	change: Readonly<{
		permissions: Iterable<KookPermission>
		effect: KookPermissionOverwriteEffect
	}>,
): KookPermissionOverwrite {
	const current = validateOverwrite(overwrite)
	const selected = BigInt(combineKookPermissions(change.permissions))
	let allow = current.allow & ~selected
	let deny = current.deny & ~selected
	if (change.effect === 'allow') allow |= selected
	else if (change.effect === 'deny') deny |= selected
	else if (change.effect !== 'inherit')
		throw new TypeError(`Unknown KOOK permission overwrite effect: ${String(change.effect)}`)
	return freezeOverwrite(Number(allow), Number(deny))
}

/**
 * Applies one valid channel overwrite to a permission mask. Administrators bypass channel
 * overwrites, matching KOOK guild permission semantics. This function does not choose or fetch
 * role/user overwrites; the caller must supply them in the platform-defined order.
 */
export function applyKookPermissionOverwrite(
	mask: number,
	overwrite: KookPermissionOverwrite,
): number {
	const value = toMask(mask, 'mask')
	if (contains(value, BigInt(KookPermission.GUILD_ADMIN))) return Number(value)
	const { allow, deny } = validateOverwrite(overwrite)
	return Number((value & ~deny) | allow)
}

function validateOverwrite(overwrite: KookPermissionOverwrite): { allow: bigint; deny: bigint } {
	const allow = toMask(overwrite.allow, 'overwrite.allow')
	const deny = toMask(overwrite.deny, 'overwrite.deny')
	if ((allow & deny) !== 0n)
		throw new RangeError('KOOK permission overwrite cannot allow and deny the same permission')
	return { allow, deny }
}

function freezeOverwrite(allow: number, deny: number): KookPermissionOverwrite {
	validateOverwrite({ allow, deny })
	return Object.freeze({ allow, deny })
}

function toPermissionBit(permission: KookPermission): bigint {
	if (!knownPermissions.has(permission))
		throw new RangeError(`Unknown KOOK permission value: ${String(permission)}`)
	return BigInt(permission)
}

function toMask(value: number, name: string): bigint {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError(`${name} must be a non-negative safe integer`)
	return BigInt(value)
}

function contains(mask: bigint, permission: bigint): boolean {
	return (mask & permission) === permission
}
