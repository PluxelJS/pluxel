import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

describe('HttpPlugin', () => {
	it('exposes a validated Todo API backed by a required Plugin dependency', async () => {
		await using host = createRuntimeTestHost()
		await host.commit((change) => {
			change.config.seed(TodoPlugin, { maxItems: 2, seedTitle: 'First task' })
			change.start(HttpPlugin, { catalog: [TodoPlugin] })
		})

		const list = await host.http.fetch(new URL('/api/example/todos', host.http.origin))
		expect(list.status).toBe(200)
		expect(await list.json()).toMatchObject({
			items: [{ id: 'todo-1', title: 'First task', completed: false }],
			maxItems: 2,
		})

		const invalid = await host.http.fetch(new URL('/api/example/todos', host.http.origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: '' }),
		})
		expect(invalid.status).toBe(422)

		const created = await host.http.fetch(new URL('/api/example/todos', host.http.origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Second task' }),
		})
		expect(created.status).toBe(201)
		const createdBody = await created.json()
		expect(createdBody.items).toHaveLength(2)

		const limited = await host.http.fetch(new URL('/api/example/todos', host.http.origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Third task' }),
		})
		expect(limited.status).toBe(409)
		expect(await limited.json()).toEqual({ error: 'limit-reached' })

		const completed = await host.http.fetch(
			new URL('/api/example/todos/todo-1', host.http.origin),
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ completed: true }),
			},
		)
		expect(completed.status).toBe(200)
		const completedBody = await completed.json()
		expect(completedBody.items[0].completed).toBe(true)

		await host.stop(HttpPlugin)
		const removed = await host.http.fetch(new URL('/api/example/todos', host.http.origin))
		expect(removed.status).toBe(404)
	})
})
