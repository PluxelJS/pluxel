import { describe, expect, it, vi } from 'vitest'
import {
	DiscordManagedCommandStore,
	reconcileDiscordCommands,
	type DiscordCommandManager,
	type DiscordRemoteCommand,
} from '../src/bot/command-sync.ts'

describe('Discord command synchronization', () => {
	it('reconciles carrier roots without touching unrelated application commands', async () => {
		const remote = new Map<string, DiscordRemoteCommand>([
			['same-id', command('same-id', 'same', 'Same', [])],
			['changed-id', command('changed-id', 'changed', 'Old', [])],
			['stale-id', command('stale-id', 'stale', 'Stale', [])],
			['other-id', command('other-id', 'other', 'Other', [])],
		])
		const create = vi.fn(async () => undefined)
		const edit = vi.fn(async () => undefined)
		const remove = vi.fn(async () => undefined)
		const manager: DiscordCommandManager = {
			fetch: async () => remote,
			create,
			edit,
			delete: remove,
		}
		const current = await reconcileDiscordCommands(
			manager,
			[
				{ name: 'same', description: 'Same', options: [] },
				{ name: 'changed', description: 'Changed', options: [] },
				{ name: 'new', description: 'New', options: [] },
			],
			new Set(['same', 'changed', 'stale']),
		)

		expect(current).toEqual(new Set(['same', 'changed', 'new']))
		expect(create).toHaveBeenCalledWith({ name: 'new', description: 'New', options: [] })
		expect(edit).toHaveBeenCalledTimes(1)
		expect(edit).toHaveBeenCalledWith('changed-id', {
			name: 'changed',
			description: 'Changed',
			options: [],
		})
		expect(remove).toHaveBeenCalledExactlyOnceWith('stale-id')
	})

	it('persists managed roots independently for each Bot account', async () => {
		const values = new Map<string, unknown>()
		const store = new DiscordManagedCommandStore({
			get: async <Value>(key: string) => values.get(key) as Value | undefined,
			set: async (key, value) => {
				values.set(key, value)
			},
			delete: async (key) => {
				values.delete(key)
			},
			keys: async () => [...values.keys()],
		})
		await store.write('music', new Map([['global', new Set(['rhythm', 'admin'])]]))
		await store.write('radio', new Map([['guild:12345678901234567', new Set(['radio'])]]))
		expect(await store.read('music')).toEqual(new Map([['global', new Set(['admin', 'rhythm'])]]))
		expect(await store.read('radio')).toEqual(
			new Map([['guild:12345678901234567', new Set(['radio'])]]),
		)
		await store.delete('music')
		expect(await store.read('music')).toEqual(new Map())
	})
})

function command(
	id: string,
	name: string,
	description: string,
	options: readonly unknown[],
): DiscordRemoteCommand {
	return { id, name, toJSON: () => ({ id, name, description, options }) }
}
