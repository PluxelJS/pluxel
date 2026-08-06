import { describe, expect, it } from 'vitest'
import {
	applyKookPermissionOverwrite,
	combineKookPermissions,
	createKookPermissionOverwrite,
	getKookPermissionOverwriteEffect,
	hasAllKookPermissions,
	hasAnyKookPermission,
	hasKookPermission,
	KookPermission,
	setKookPermissionOverwrite,
} from '../src/index.ts'

describe('KOOK permission helpers', () => {
	it('exports wire-level masks for the complete current KOOK permission table', () => {
		expect(KookPermission.GUILD_ADMIN).toBe(1)
		expect(KookPermission.CHANNEL_MESSAGE).toBe(4_096)
		expect(KookPermission.CHANNEL_SCREEN_SHARE).toBe(268_435_456)
		expect(KookPermission.THREAD_REPLY).toBe(536_870_912)
		expect(KookPermission.CHANNEL_RECORDING).toBe(1_073_741_824)
		expect(Object.keys(KookPermission)).toHaveLength(31)
		expect(Object.isFrozen(KookPermission)).toBe(true)
	})

	it('combines and queries masks without signed 32-bit coercion', () => {
		const mask = combineKookPermissions([
			KookPermission.CHANNEL_VIEW,
			KookPermission.CHANNEL_MESSAGE,
			KookPermission.CHANNEL_RECORDING,
		])
		expect(mask).toBe(1_073_747_968)
		expect(hasKookPermission(mask, KookPermission.CHANNEL_RECORDING)).toBe(true)
		expect(
			hasAllKookPermissions(mask, [
				KookPermission.CHANNEL_VIEW,
				KookPermission.CHANNEL_MESSAGE,
			]),
		).toBe(true)
		expect(
			hasAnyKookPermission(mask, [
				KookPermission.GUILD_USER_BAN,
				KookPermission.CHANNEL_RECORDING,
			]),
		).toBe(true)
		expect(hasAllKookPermissions(mask, [])).toBe(true)
		expect(hasAnyKookPermission(mask, [])).toBe(false)
	})

	it('treats guild administrator as satisfying every known permission', () => {
		expect(
			hasKookPermission(KookPermission.GUILD_ADMIN, KookPermission.CHANNEL_MANAGE_MESSAGE),
		).toBe(true)
		expect(
			hasAllKookPermissions(KookPermission.GUILD_ADMIN, [
				KookPermission.GUILD_USER_BAN,
				KookPermission.CHANNEL_RECORDING,
			]),
		).toBe(true)
	})

	it('constructs immutable disjoint channel overwrites', () => {
		const overwrite = createKookPermissionOverwrite({
			allow: [KookPermission.CHANNEL_VIEW, KookPermission.CHANNEL_MESSAGE],
			deny: [KookPermission.CHANNEL_UPLOAD],
		})
		expect(overwrite).toEqual({ allow: 6_144, deny: 16_384 })
		expect(Object.isFrozen(overwrite)).toBe(true)
		expect(
			getKookPermissionOverwriteEffect(overwrite, KookPermission.CHANNEL_MESSAGE),
		).toBe('allow')
		expect(getKookPermissionOverwriteEffect(overwrite, KookPermission.CHANNEL_UPLOAD)).toBe(
			'deny',
		)
		expect(getKookPermissionOverwriteEffect(overwrite, KookPermission.GUILD_USER_BAN)).toBe(
			'inherit',
		)
		expect(() =>
			createKookPermissionOverwrite({
				allow: [KookPermission.CHANNEL_VIEW],
				deny: [KookPermission.CHANNEL_VIEW],
			}),
		).toThrow(/cannot allow and deny/)
	})

	it('updates tri-state effects without mutating or dropping unknown future bits', () => {
		const futureBit = 2 ** 40
		const current = Object.freeze({
			allow: futureBit + KookPermission.CHANNEL_VIEW,
			deny: KookPermission.CHANNEL_UPLOAD,
		})
		const denied = setKookPermissionOverwrite(current, {
			permissions: [KookPermission.CHANNEL_VIEW, KookPermission.CHANNEL_MESSAGE],
			effect: 'deny',
		})
		expect(denied).toEqual({
			allow: futureBit,
			deny:
				KookPermission.CHANNEL_VIEW +
				KookPermission.CHANNEL_MESSAGE +
				KookPermission.CHANNEL_UPLOAD,
		})
		expect(current.allow).toBe(futureBit + KookPermission.CHANNEL_VIEW)
		const inherited = setKookPermissionOverwrite(denied, {
			permissions: [KookPermission.CHANNEL_VIEW],
			effect: 'inherit',
		})
		expect(getKookPermissionOverwriteEffect(inherited, KookPermission.CHANNEL_VIEW)).toBe(
			'inherit',
		)
	})

	it('applies one overwrite while preserving the administrator bypass', () => {
		const base = combineKookPermissions([
			KookPermission.CHANNEL_VIEW,
			KookPermission.CHANNEL_UPLOAD,
		])
		const overwrite = createKookPermissionOverwrite({
			allow: [KookPermission.CHANNEL_MESSAGE],
			deny: [KookPermission.CHANNEL_UPLOAD],
		})
		const effective = applyKookPermissionOverwrite(base, overwrite)
		expect(hasKookPermission(effective, KookPermission.CHANNEL_VIEW)).toBe(true)
		expect(hasKookPermission(effective, KookPermission.CHANNEL_MESSAGE)).toBe(true)
		expect(hasKookPermission(effective, KookPermission.CHANNEL_UPLOAD)).toBe(false)
		expect(applyKookPermissionOverwrite(KookPermission.GUILD_ADMIN, overwrite)).toBe(
			KookPermission.GUILD_ADMIN,
		)
	})

	it('rejects invalid JavaScript inputs at the public boundary', () => {
		expect(() => hasKookPermission(-1, KookPermission.CHANNEL_VIEW)).toThrow(
			/non-negative safe integer/,
		)
		expect(() =>
			combineKookPermissions([123 as (typeof KookPermission)[keyof typeof KookPermission]]),
		).toThrow(/Unknown KOOK permission value/)
		expect(() =>
			setKookPermissionOverwrite(
				{ allow: KookPermission.CHANNEL_VIEW, deny: KookPermission.CHANNEL_VIEW },
				{ permissions: [], effect: 'inherit' },
			),
		).toThrow(/cannot allow and deny/)
	})
})
