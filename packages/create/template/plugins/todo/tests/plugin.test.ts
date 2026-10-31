import { AuditPlugin } from '@example/audit-plugin'
import { TodoPlugin } from '@example/todo-plugin'
import { createTestHost } from '@pluxel/test'
import { fs, InMemory } from '@pluxel/services/fs'
import { TinyBase, tinybase } from '@pluxel/services/tinybase'
import { describe, expect, it } from 'vitest'

describe('TodoPlugin', () => {
	it('uses validated config and attaches an optional Plugin when available', async () => {
		await using host = await createTestHost({ services: [fs({ backend: InMemory }), tinybase()] })
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
		).toEqual(['todo.added:todo-2', 'todo.completed:todo-1:true'])
	})

	it('keeps the optional integration absent-safe', async () => {
		await using host = await createTestHost({ services: [fs({ backend: InMemory }), tinybase()] })

		const todos = await host.start(TodoPlugin)
		expect(todos.snapshot().auditEnabled).toBe(false)
	})
	it('restores changes and keeps an empty collection empty without replaying the seed', async () => {
		await using host = await createTestHost({ services: [fs({ backend: InMemory }), tinybase()] })
		let todos = await host.start(TodoPlugin)
		expect(todos.add('Remember this task')).toMatchObject({ ok: true })
		todos.setCompleted('todo-2', true)
		todos.remove('todo-1')
		await host.restart(TodoPlugin)
		todos = host.require(TodoPlugin)
		expect(todos.snapshot().items).toEqual([
			{ id: 'todo-2', title: 'Remember this task', completed: true },
		])
		todos.remove('todo-2')
		await host.restart(TodoPlugin)
		todos = host.require(TodoPlugin)
		expect(todos.snapshot().items).toEqual([])
		expect(todos.add('Next task')).toMatchObject({ ok: true, item: { id: 'todo-3' } })
	})

	it('rejects corrupted restored rows before exposing Todo methods', async () => {
		await using host = await createTestHost({ services: [fs({ backend: InMemory }), tinybase()] })
		const todos = await host.start(TodoPlugin)
		const state = todos.ctx.require(TinyBase)
		const store = await state.open()
		store.setCell('todos', 'todo-1', 'completed', 'invalid')
		await state.flush()
		await host.stop(TodoPlugin)
		const failure = await host.commitExpectFail((change) => change.start(TodoPlugin))
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({ kind: 'start-failed' }),
		)
	})

	it('does not replace a valid empty snapshot with its initial seed', async () => {
		await using host = await createTestHost({ services: [fs({ backend: InMemory }), tinybase()] })
		const todos = await host.start(TodoPlugin)
		const state = todos.ctx.require(TinyBase)
		;(await state.open()).setContent([{}, {}])
		await state.flush()
		await host.restart(TodoPlugin)
		expect(host.require(TodoPlugin).snapshot().items).toEqual([])
	})
})
