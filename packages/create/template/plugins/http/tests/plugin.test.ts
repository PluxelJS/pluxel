import { createHost } from '@pluxel/host'
import { pluginNodeAddressOf } from '@pluxel/core'
import { http as httpService } from '@pluxel/services/http'
import { createHostHttpHandler } from '@pluxel/services/http/application'
import { describe, expect, it } from 'vitest'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

describe('HttpPlugin', () => {
	it('exposes a validated Todo API backed by a required Plugin dependency', async () => {
		const host = await createHost({
			plugins: [HttpPlugin, TodoPlugin],
			services: [httpService()],
			configRecords: {
				initial: [
					{
						owner: pluginNodeAddressOf(TodoPlugin),
						config: { maxItems: 2, seedTitle: 'First task' },
					},
				],
			},
		})
		try {
			await host.startNode(pluginNodeAddressOf(HttpPlugin))
			const handler = createHostHttpHandler(host)
			const http = {
				origin: 'http://test.local',
				fetch: (input: URL, init?: RequestInit) => handler(new Request(input, init)),
			}

			const list = await http.fetch(new URL('/api/example/todos', http.origin))
			expect(list.status).toBe(200)
			expect(await list.json()).toMatchObject({
				items: [{ id: 'todo-1', title: 'First task', completed: false }],
				maxItems: 2,
			})

			const invalid = await http.fetch(new URL('/api/example/todos', http.origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: '' }),
			})
			expect(invalid.status).toBe(422)

			const created = await http.fetch(new URL('/api/example/todos', http.origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Second task' }),
			})
			expect(created.status).toBe(201)
			const createdBody = await created.json()
			expect(createdBody.items).toHaveLength(2)

			const limited = await http.fetch(new URL('/api/example/todos', http.origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Third task' }),
			})
			expect(limited.status).toBe(409)
			expect(await limited.json()).toEqual({ error: 'limit-reached' })

			const completed = await http.fetch(new URL('/api/example/todos/todo-1', http.origin), {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ completed: true }),
			})
			expect(completed.status).toBe(200)
			const completedBody = await completed.json()
			expect(completedBody.items[0].completed).toBe(true)

			await host.stopNode(pluginNodeAddressOf(HttpPlugin))
			const removed = await http.fetch(new URL('/api/example/todos', http.origin))
			expect(removed.status).toBe(404)
		} finally {
			await host.close()
		}
	})
})
