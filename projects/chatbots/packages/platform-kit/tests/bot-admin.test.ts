import { describe, expect, it, vi } from 'vitest'
import {
	attachBotAdminState,
	BotAdminRpc,
	maskBotSecret,
	type BotAdminAccount,
} from '../src/bot-admin.ts'

type TestAccount = BotAdminAccount<{ received: number }>

describe('Bot Workbench administration', () => {
	it('forwards commands while normalizing test failures for the UI', async () => {
		const upsert = vi.fn(async () => undefined)
		const rpc = new BotAdminRpc({
			upsert,
			remove: async () => undefined,
			reconnect: async () => undefined,
			disconnect: async () => undefined,
			test: async (id) => {
				if (id === 'broken') throw new Error('invalid token')
				return `${id} ready`
			},
		})

		await expect(rpc.upsertBot({ id: 'primary', token: 'secret' })).resolves.toEqual({ ok: true })
		expect(upsert).toHaveBeenCalledWith({ id: 'primary', token: 'secret' })
		await expect(rpc.testBot('primary')).resolves.toEqual({ ok: true, message: 'primary ready' })
		await expect(rpc.testBot('broken')).resolves.toEqual({ ok: false, message: 'invalid token' })
	})

	it('publishes full snapshots and owns subscription cleanup', () => {
		const account = {
			id: 'primary',
			apiBase: 'https://example.test',
			tokenPreview: '••••••••',
			phase: 'online',
			identityId: '42',
			username: 'bot',
			lastError: null as string | null,
			connectedAt: 1,
			updatedAt: 2,
			diagnostics: { received: 3 },
		} as const satisfies TestAccount
		const listeners = new Set<() => void>()
		const controller = new AbortController()
		const emit = vi.fn()
		attachBotAdminState(
			() => [account],
			(listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			{ emit, signal: controller.signal },
		)

		expect(emit).toHaveBeenCalledWith('snapshot', { accounts: [account] })
		controller.abort()
		expect(listeners.size).toBe(0)
	})

	it('masks short and long credentials without exposing the full value', () => {
		expect(maskBotSecret('short')).toBe('••••••••')
		expect(maskBotSecret('super-secret-token')).toBe('supe••••oken')
	})
})
