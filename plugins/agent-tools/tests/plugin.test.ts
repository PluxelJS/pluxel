import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { BasePlugin, createRuntimeTestHost, Plugin } from '@pluxel/runtime/test'
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
		await using host = createRuntimeTestHost({ workbench: false })
		await host.start(AgentToolsPlugin, { catalog: [NotesCommands], initialConfig: policy })
		await host.start(NotesCommands)

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
	})

	it('projects toolsets, assignments, missing tools and ungrouped commands for Workbench', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await host.start(AgentToolsPlugin, {
			catalog: [NotesCommands],
			initialConfig: {
				toolsets: [
					{
						id: 'reader',
						label: 'Reader',
						description: 'Read-only tools',
						commandNames: ['notes.read', 'notes.missing'],
					},
				],
				agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['reader'] }],
			},
		})
		await host.start(NotesCommands)

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
	})

	it('keeps missing command names and projects them when an owner starts', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await host.start(AgentToolsPlugin, { catalog: [NotesCommands], initialConfig: policy })

		const catalog = host.require(AgentToolsPlugin).catalog('researcher')
		expect(catalog.list()).toEqual([])
		let published: string[] = []
		const unsubscribe = catalog.subscribe((snapshot) => {
			published = snapshot.descriptors.map(({ name }) => name)
		})

		await host.start(NotesCommands)
		expect(catalog.list().map(({ name }) => name)).toEqual(['notes.read'])
		expect(published).toEqual(['notes.read'])
		unsubscribe()
	})

	it('withdraws stale catalogs when the Plugin stops', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await host.start(AgentToolsPlugin, { catalog: [NotesCommands], initialConfig: policy })
		await host.start(NotesCommands)

		const catalog = host.require(AgentToolsPlugin).catalog('researcher')
		expect(catalog.snapshot().available).toBe(true)
		let available = true
		const unsubscribe = catalog.subscribe((snapshot) => {
			available = snapshot.available
		})
		await host.stop(AgentToolsPlugin)
		expect(available).toBe(false)
		expect(catalog.snapshot()).toMatchObject({ available: false, descriptors: [] })
		await expect(catalog.execute('notes.read', {})).rejects.toMatchObject({ code: 'ABORTED' })
		unsubscribe()
	})

	it('rejects Agent assignments that reference unknown Toolsets', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await expect(
			host.start(AgentToolsPlugin, {
				initialConfig: {
					agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['missing'] }],
				},
			}),
		).rejects.toMatchObject({ code: 'validation_failed' })
		expect(host.isRunning(AgentToolsPlugin)).toBe(false)
	})
})
