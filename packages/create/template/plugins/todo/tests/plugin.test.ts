import { AuditPlugin } from '@example/audit-plugin'
import { TodoPlugin } from '@example/todo-plugin'
import { createTestHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'

describe('TodoPlugin', () => {
	it('uses validated config and attaches an optional Plugin when available', async () => {
		await using host = await createTestHost()
		await host.commit((change) => {
			change.start(AuditPlugin)
			change.start(TodoPlugin, {
				initialConfig: { maxItems: 2, seedTitle: 'Read the docs' },
			})
		})

		const todos = host.require(TodoPlugin)
		expect(todos.add('Build a Plugin')).toMatchObject({ ok: true })
		expect(todos.add('This exceeds the configured limit')).toEqual({
			ok: false,
			reason: 'limit-reached',
		})
		expect(todos.setCompleted('todo-1', true)?.completed).toBe(true)
		expect(todos.snapshot()).toMatchObject({ maxItems: 2, auditEnabled: true })
		expect(
			host
				.require(AuditPlugin)
				.entries()
				.map((entry) => entry.message),
		).toEqual(['todo.added:todo-1', 'todo.added:todo-2', 'todo.completed:todo-1:true'])
	})

	it('keeps the optional integration absent-safe', async () => {
		await using host = await createTestHost()

		const todos = await host.start(TodoPlugin)
		expect(todos.snapshot().auditEnabled).toBe(false)
	})
})
