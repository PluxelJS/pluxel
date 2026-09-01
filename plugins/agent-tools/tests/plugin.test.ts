import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { AgentToolsPlugin } from '../src/index.ts'

const readCommand = defineCommand({
	name: 'notes.read',
	description: 'Read notes.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({}),
	output: obj({ value: Type.String() }),
	execute: () => ({ value: 'read' }),
})

const deleteCommand = defineCommand({
	name: 'notes.delete',
	description: 'Delete notes.',
	behavior: { kind: 'mutation', destructive: true, idempotent: true, world: 'closed' },
	input: obj({}),
	output: obj({ value: Type.String() }),
	execute: () => ({ value: 'deleted' }),
})

@Plugin()
class NotesCommands extends BasePlugin {
	protected override init(): void {
		this.ctx.commands.register(readCommand)
		this.ctx.commands.register(deleteCommand)
	}
}

const policy = {
	toolsets: [
		{ id: 'notes-reader', label: 'Notes reader', commandNames: ['notes.read'] },
		{ id: 'notes-writer', label: 'Notes writer', commandNames: ['notes.delete'] },
	],
	agents: [
		{ agentId: 'researcher', label: 'Researcher', toolsetIds: ['notes-reader'] },
		{
			agentId: 'operator',
			label: 'Operator',
			toolsetIds: ['notes-reader', 'notes-writer'],
		},
	],
} as const

describe('AgentToolsPlugin', () => {
	it('projects the shared command catalog and rechecks assignment during execution', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesCommands])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin).start(NotesCommands)
			await host.commit()

			const tools = host.require(AgentToolsPlugin)
			const researcher = tools.catalog('researcher')
			expect(researcher.list().map(({ name }) => name)).toEqual(['notes.read'])
			await expect(researcher.execute('notes.read', {})).resolves.toEqual({ value: 'read' })
			await expect(researcher.execute('notes.delete', {})).rejects.toMatchObject({
				code: 'FORBIDDEN',
				details: { reason: 'command_not_assigned' },
			})

			const operator = tools.catalog('operator')
			expect(operator.list().map(({ name }) => name)).toEqual(['notes.delete', 'notes.read'])
			await expect(operator.execute('notes.delete', {})).resolves.toEqual({ value: 'deleted' })
		} finally {
			await host.dispose()
		}
	})

	it('projects toolsets, assignments, missing tools and ungrouped commands for Workbench', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesCommands])
			host.cfg(AgentToolsPlugin).set({
				toolsets: [
					{
						id: 'reader',
						label: 'Reader',
						description: 'Read-only tools',
						commandNames: ['notes.read', 'notes.missing'],
					},
				],
				agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['reader'] }],
			})
			host.start(AgentToolsPlugin).start(NotesCommands)
			await host.commit()

			const snapshot = host.require(AgentToolsPlugin).snapshot()
			expect(snapshot).toMatchObject({
				toolsets: [
					{
						id: 'reader',
						availableCommandNames: ['notes.read'],
						missingCommandNames: ['notes.missing'],
					},
				],
				assignments: [
					{
						agentId: 'assistant',
						commandNames: ['notes.missing', 'notes.read'],
						availableCommandNames: ['notes.read'],
						missingCommandNames: ['notes.missing'],
					},
				],
			})
			expect(snapshot.commands.map(({ name }) => name)).toEqual(
				expect.arrayContaining(['notes.delete', 'notes.read']),
			)
			expect(snapshot.ungroupedCommandNames).toEqual(expect.arrayContaining(['notes.delete']))
		} finally {
			await host.dispose()
		}
	})

	it('keeps missing command names and projects them when an owner starts', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesCommands])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin)
			await host.commit()

			const catalog = host.require(AgentToolsPlugin).catalog('researcher')
			expect(catalog.list()).toEqual([])
			let published: string[] = []
			const unsubscribe = catalog.subscribe((snapshot) => {
				published = snapshot.descriptors.map(({ name }) => name)
			})

			host.start(NotesCommands)
			await host.commit()
			expect(catalog.list().map(({ name }) => name)).toEqual(['notes.read'])
			expect(published).toEqual(['notes.read'])
			unsubscribe()
		} finally {
			await host.dispose()
		}
	})

	it('withdraws stale catalogs when the Plugin stops', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesCommands])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin).start(NotesCommands)
			await host.commit()

			const catalog = host.require(AgentToolsPlugin).catalog('researcher')
			expect(catalog.snapshot().available).toBe(true)
			let available = true
			const unsubscribe = catalog.subscribe((snapshot) => {
				available = snapshot.available
			})
			host.stop(AgentToolsPlugin)
			await host.commit()
			expect(available).toBe(false)
			expect(catalog.snapshot()).toMatchObject({ available: false, descriptors: [] })
			await expect(catalog.execute('notes.read', {})).rejects.toMatchObject({ code: 'ABORTED' })
			unsubscribe()
		} finally {
			await host.dispose()
		}
	})

	it('rejects Agent assignments that reference unknown Toolsets', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(AgentToolsPlugin)
			host.cfg(AgentToolsPlugin).set({
				agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['missing'] }],
			})
			host.start(AgentToolsPlugin)
			await host.commitAllowFail()
			expect(host.isRunning(AgentToolsPlugin)).toBe(false)
		} finally {
			await host.dispose()
		}
	})
})
