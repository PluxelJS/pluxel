import { withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

describe('HttpPlugin', () => {
	it('exposes a validated Todo API backed by a required Plugin dependency', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([TodoPlugin, HttpPlugin])
				host.cfg(TodoPlugin).set({ maxItems: 2, seedTitle: 'First task' })
				host.cfg(TodoPlugin).enable()
				host.cfg(HttpPlugin).enable()
				await host.commit()

				const list = await host.ctx.http.fetch(new Request('http://local.test/api/example/todos'))
				expect(list.status).toBe(200)
				expect(await list.json()).toMatchObject({
					items: [{ id: 'todo-1', title: 'First task', completed: false }],
					maxItems: 2,
				})

				const created = await host.ctx.http.fetch(
					new Request('http://local.test/api/example/todos', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ title: 'Second task' }),
					}),
				)
				expect(created.status).toBe(201)
				expect((await created.json()).items).toHaveLength(2)

				const limited = await host.ctx.http.fetch(
					new Request('http://local.test/api/example/todos', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ title: 'Third task' }),
					}),
				)
				expect(limited.status).toBe(409)
				expect(await limited.json()).toEqual({ error: 'limit-reached' })

				const completed = await host.ctx.http.fetch(
					new Request('http://local.test/api/example/todos/todo-1', {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ completed: true }),
					}),
				)
				expect(completed.status).toBe(200)
				expect((await completed.json()).items[0].completed).toBe(true)
			},
			{ workbench: false },
		)
	})
})
