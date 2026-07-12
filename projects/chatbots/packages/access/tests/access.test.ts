import { describe, expect, it } from 'vitest'
import {
	ChatAccessDomain,
	createEmptyAccessState,
	decideGrants,
	normalizeAccessState,
} from '../src/index.ts'

describe('chat access policy', () => {
	it('uses exact grants before the longest wildcard', () => {
		const grants = [
			{ node: 'cmd.*', effect: 'deny' },
			{ node: 'cmd.admin.*', effect: 'allow' },
			{ node: 'cmd.admin.stop', effect: 'deny' },
		] as const
		expect(decideGrants(grants, 'cmd.help')).toBe('deny')
		expect(decideGrants(grants, 'cmd.admin.start')).toBe('allow')
		expect(decideGrants(grants, 'cmd.admin.stop')).toBe('deny')
	})

	it('merges platform identities without a Pluxel runtime', () => {
		const domain = new ChatAccessDomain(createEmptyAccessState(), () => {})
		const first = domain.resolveMessage(message('telegram', '1'))
		const second = domain.resolveMessage(message('kook', '2'))
		const { code } = domain.createLinkCode(first.id)
		const linked = domain.consumeLinkCode(second.id, code)

		expect(linked.id).toBe(first.id)
		expect(linked.identities.map((identity) => identity.platform).sort()).toEqual([
			'kook',
			'telegram',
		])
	})

	it('keeps one platform identity stable across bot accounts', () => {
		const domain = new ChatAccessDomain(createEmptyAccessState(), () => {})
		const first = domain.resolveMessage(message('telegram', '1', 'notifications'))
		const second = domain.resolveMessage(message('telegram', '1', 'moderation'))
		expect(second.id).toBe(first.id)
		expect(domain.listUsers()).toHaveLength(1)
	})

	it('caches role order safely and keeps declaration disposal idempotent', () => {
		const changes: string[] = []
		const domain = new ChatAccessDomain(createEmptyAccessState(), (kind) => changes.push(kind))
		const user = domain.resolveMessage(message('telegram', '1'))
		const disposeFirst = domain.declare({
			node: 'cmd.deploy',
			description: 'deploy',
			defaultEffect: 'deny',
		})
		const disposeSecond = domain.declare({
			node: 'cmd.deploy',
			description: 'deploy again',
			defaultEffect: 'deny',
		})
		domain.upsertRole({
			id: 'operator',
			name: 'Operator',
			rank: 10,
			grants: [{ node: 'cmd.deploy', effect: 'allow' }],
		})
		domain.assignRole(user.id, 'operator')
		expect(domain.authorize(user.id, 'cmd.deploy')).toBe(true)

		domain.upsertRole({
			id: 'operator',
			name: 'Operator',
			rank: 10,
			grants: [{ node: 'cmd.deploy', effect: 'deny' }],
		})
		expect(domain.authorize(user.id, 'cmd.deploy')).toBe(false)
		disposeFirst()
		disposeFirst()
		expect(domain.listPermissions()).toHaveLength(1)
		disposeSecond()
		expect(domain.listPermissions()).toHaveLength(0)
		expect(changes.filter((kind) => kind === 'declarations')).toHaveLength(2)
	})

	it('repairs partial persisted state before it enters the domain', () => {
		const state = normalizeAccessState({
			sequence: 1,
			users: [
				{
					id: 'user-8',
					displayName: 'Alice',
					identities: [{ transport: 'telegram', actorId: '1' }, { broken: true }],
				},
				{ id: 'broken', identities: [] },
			],
			roles: [{ id: 'admin', name: 'Admin', rank: 10, grants: [{ node: '..', effect: 'allow' }] }],
			userRoles: { 'user-8': ['admin', 'missing'] },
			userGrants: { 'user-8': [{ node: 'cmd.help', effect: 'allow' }, null] },
		})
		expect(state.sequence).toBe(9)
		expect(state.users).toHaveLength(1)
		expect(state.roles[0]?.grants).toEqual([])
		expect(state.userRoles['user-8']).toEqual(['admin'])
		expect(state.userGrants['user-8']).toEqual([{ node: 'cmd.help', effect: 'allow' }])
	})

	it('rotates link codes and throttles brute-force attempts', () => {
		const domain = new ChatAccessDomain(createEmptyAccessState(), () => {})
		const first = domain.resolveMessage(message('telegram', '1'))
		const second = domain.resolveMessage(message('kook', '2'))
		const expired = domain.createLinkCode(first.id).code
		const current = domain.createLinkCode(first.id).code
		expect(() => domain.consumeLinkCode(second.id, expired)).toThrow('无效')
		for (let index = 0; index < 7; index++)
			expect(() => domain.consumeLinkCode(second.id, '000000')).toThrow('无效')
		expect(() => domain.consumeLinkCode(second.id, current)).toThrow('尝试过多')
	})
})

function message(platform: string, actorId: string, accountId = 'default') {
	return {
		id: `${platform}-message`,
		platform,
		accountId,
		conversation: { id: 'room', kind: 'direct' as const },
		actor: { id: actorId },
		content: [{ type: 'text' as const, text: 'hello' }],
		text: 'hello',
		createdAt: Date.now(),
	}
}
