import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'
import { Elysia } from 'elysia'

describe('HttpPlugin', () => {
	it('exposes a validated Todo API backed by a required Plugin dependency', async () => {
		{
			await using host = createRuntimeHost({ workbench: false })

			host.add([TodoPlugin, HttpPlugin])
			host.cfg(TodoPlugin).set({ maxItems: 2, seedTitle: 'First task' })
			host.start(HttpPlugin)
			await host.commit()

			expect(host.require(HttpPlugin).ctx.elysia).toBeInstanceOf(Elysia)

			const list = await host.fetch(new Request('http://local.test/api/example/todos'))
			expect(list.status).toBe(200)
			expect(await list.json()).toMatchObject({
				items: [{ id: 'todo-1', title: 'First task', completed: false }],
				maxItems: 2,
			})

			const invalid = await host.fetch(
				new Request('http://local.test/api/example/todos', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: '' }),
				}),
			)
			expect(invalid.status).toBe(422)

			const created = await host.fetch(
				new Request('http://local.test/api/example/todos', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Second task' }),
				}),
			)
			expect(created.status).toBe(201)
			const createdBody = await created.json()
			expect(createdBody.items).toHaveLength(2)

			const limited = await host.fetch(
				new Request('http://local.test/api/example/todos', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Third task' }),
				}),
			)
			expect(limited.status).toBe(409)
			expect(await limited.json()).toEqual({ error: 'limit-reached' })

			const completed = await host.fetch(
				new Request('http://local.test/api/example/todos/todo-1', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ completed: true }),
				}),
			)
			expect(completed.status).toBe(200)
			const completedBody = await completed.json()
			expect(completedBody.items[0].completed).toBe(true)

			host.remove(HttpPlugin)
			await host.commit()
			const removed = await host.fetch(new Request('http://local.test/api/example/todos'))
			expect(removed.status).toBe(404)
		}
	})
})
