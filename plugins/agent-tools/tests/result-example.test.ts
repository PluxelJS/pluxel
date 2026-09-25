import { createTestHost } from '@pluxel/test'
import { commands } from '@pluxel/services/commands'
import { expect, it, vi } from 'vitest'
import { AgentToolsPlugin } from '../src/index.ts'
import { NotesWithResults } from './fixtures/result-consumer.ts'

it('projects domain Results to command JSON while retaining policy and defect classification', async () => {
	await using host = await createTestHost({ services: [commands()] })
	await host.start(AgentToolsPlugin, {
		initialConfig: {
			toolsets: [{ id: 'notes', label: 'Notes', commandNames: ['notes.lookup'] }],
			agents: [{ agentId: 'reader', label: 'Reader', toolsetIds: ['notes'] }],
		},
	})
	await host.start(NotesWithResults)
	const tools = host.require(AgentToolsPlugin)
	const reader = tools.catalog('reader')
	await expect(reader.execute('notes.lookup', { id: 'welcome' })).resolves.toEqual({
		id: 'welcome',
		text: 'Welcome',
	})
	await expect(reader.execute('notes.lookup', { id: 'missing' })).rejects.toMatchObject({
		code: 'INPUT_VALIDATION',
		kind: 'expected',
		details: { issues: [{ code: 'note_not_found', path: ['id'] }] },
	})
	await expect(
		tools.catalog('unassigned').execute('notes.lookup', { id: 'welcome' }),
	).rejects.toMatchObject({ code: 'FORBIDDEN' })
	const spy = vi.spyOn(NotesWithResults.prototype, 'find').mockImplementation(() => {
		throw new Error('defect')
	})
	try {
		await expect(reader.execute('notes.lookup', { id: 'welcome' })).rejects.toMatchObject({
			code: 'INTERNAL',
		})
	} finally {
		spy.mockRestore()
	}
})
