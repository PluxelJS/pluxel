import { defineCommand } from '@pluxel/commands'
import { obj } from '@pluxel/commands/typebox'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'

const readCommand = defineCommand({
	name: 'notes.read',
	description: 'Read notes.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({}),
	execute: () => undefined,
})

const deleteCommand = defineCommand({
	name: 'notes.delete',
	description: 'Delete notes.',
	behavior: { kind: 'mutation', destructive: true, idempotent: true, world: 'closed' },
	input: obj({}),
	execute: () => undefined,
})

@Plugin()
class NotesCommands extends BasePlugin {
	override init(): void {
		this.ctx.commands.register(readCommand)
		this.ctx.commands.register(deleteCommand)
	}
}

describe('AgentToolsService', () => {
	it('projects one live catalog and enforces the same assignment during execution', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(NotesCommands)
			host.cfg(NotesCommands).enable()
			await host.commit()

			const initial = await host.ctx.agentTools.snapshot()
			const configured = await host.ctx.agentTools.replacePolicy(initial.revision, {
				toolsets: [
					{
						id: 'notes-reader',
						label: 'Notes reader',
						commandNames: ['notes.read'],
					},
					{
						id: 'notes-writer',
						label: 'Notes writer',
						commandNames: ['notes.delete'],
					},
				],
				agents: [
					{ agentId: 'researcher', label: 'Researcher', toolsetIds: ['notes-reader'] },
					{
						agentId: 'operator',
						label: 'Operator',
						toolsetIds: ['notes-reader', 'notes-writer'],
					},
				],
			})

			const catalog = await host.ctx.agentTools.catalog('researcher')
			expect(catalog.list().map(({ name }) => name)).toEqual(['notes.read'])
			await expect(catalog.execute('notes.read', {})).resolves.toBeUndefined()
			await expect(catalog.execute('notes.delete', {})).rejects.toMatchObject({
				code: 'FORBIDDEN',
				details: { reason: 'command_not_assigned' },
			})
			const operator = await host.ctx.agentTools.catalog('operator')
			expect(operator.list().map(({ name }) => name)).toEqual(['notes.delete', 'notes.read'])
			await expect(operator.execute('notes.delete', {})).resolves.toBeUndefined()

			await host.ctx.agentTools.replacePolicy(configured.revision, {
				toolsets: configured.policy.toolsets,
				agents: configured.policy.agents.filter(({ agentId }) => agentId !== 'researcher'),
			})
			expect(catalog.list()).toEqual([])
			await expect(catalog.execute('notes.read', {})).rejects.toMatchObject({
				code: 'FORBIDDEN',
				details: { reason: 'command_not_assigned' },
			})

			host.remove(NotesCommands)
			await host.commit()
			expect(catalog.list()).toEqual([])
			const stopped = await host.ctx.agentTools.snapshot()
			expect(stopped.policy.toolsets[0]?.commandNames).toEqual(['notes.read'])
		} finally {
			await host.dispose()
		}
	})

	it('keeps missing command references and restores them when the owner returns', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			const initial = await host.ctx.agentTools.snapshot()
			await host.ctx.agentTools.replacePolicy(initial.revision, {
				toolsets: [
					{
						id: 'notes-reader',
						label: 'Notes reader',
						commandNames: ['notes.read'],
					},
				],
				agents: [{ agentId: 'researcher', label: 'Researcher', toolsetIds: ['notes-reader'] }],
			})
			const catalog = await host.ctx.agentTools.catalog('researcher')
			expect(catalog.list()).toEqual([])
			let published: string[] = []
			const unsubscribe = catalog.subscribe((snapshot) => {
				published = snapshot.descriptors.map(({ name }) => name)
			})

			host.add(NotesCommands)
			host.cfg(NotesCommands).enable()
			await host.commit()
			expect(catalog.list().map(({ name }) => name)).toEqual(['notes.read'])
			expect(published).toEqual(['notes.read'])
			unsubscribe()
		} finally {
			await host.dispose()
		}
	})

	it('persists policy and rejects stale or structurally invalid replacements', async () => {
		const backend = createMemoryPersistenceBackend()
		const config = {
			workbench: false as const,
			persistence: { mode: 'custom' as const, backend },
		}
		const first = createRuntimeHost(config)
		try {
			const initial = await first.ctx.agentTools.snapshot()
			const saved = await first.ctx.agentTools.replacePolicy(initial.revision, {
				toolsets: [{ id: 'base', label: 'Base', commandNames: ['plugin.list'] }],
				agents: [{ agentId: 'pi', label: 'Pi', toolsetIds: ['base'] }],
			})
			await expect(
				first.ctx.agentTools.replacePolicy(initial.revision, saved.policy),
			).rejects.toThrow('revision conflict')
			await expect(
				first.ctx.agentTools.replacePolicy(saved.revision, {
					toolsets: [],
					agents: [{ agentId: 'pi', label: 'Pi', toolsetIds: ['missing'] }],
				}),
			).rejects.toThrow('unknown toolset')
		} finally {
			await first.dispose()
		}

		const second = createRuntimeHost(config)
		try {
			const restored = await second.ctx.agentTools.snapshot()
			expect(restored.policy).toEqual({
				toolsets: [{ id: 'base', label: 'Base', commandNames: ['plugin.list'] }],
				agents: [{ agentId: 'pi', label: 'Pi', toolsetIds: ['base'] }],
			})
			const catalog = await second.ctx.agentTools.catalog('pi')
			expect(catalog.list().map(({ name }) => name)).toEqual(['plugin.list'])
		} finally {
			await second.dispose()
		}
	})
})
