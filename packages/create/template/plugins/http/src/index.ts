import { TODO_TITLE_MAX_LENGTH } from '@example/domain'
import { TodoPlugin } from '@example/todo-plugin'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { t } from 'elysia'

@Plugin({ displayName: 'Example HTTP API' })
export class HttpPlugin extends BasePlugin {
	constructor(private readonly todos: TodoPlugin) {
		super()
	}

	protected override init(): void {
		this.ctx.elysia.group('/api/example', (app) =>
			app
				.get('/todos', () => this.todos.snapshot())
				.post(
					'/todos',
					{
						body: t.Object({
							title: t.String({
								minLength: 1,
								maxLength: TODO_TITLE_MAX_LENGTH,
								pattern: '.*\\S.*',
							}),
						}),
					},
					({ body, set }) => {
						const result = this.todos.add(body.title)
						if (!result.ok) {
							set.status = 409
							return { error: result.reason }
						}
						set.status = 201
						return this.todos.snapshot()
					},
				)
				.patch(
					'/todos/:id',
					{ body: t.Object({ completed: t.Boolean() }) },
					({ body, params, set }) => {
						if (!this.todos.setCompleted(params.id, body.completed)) {
							set.status = 404
							return { error: 'todo-not-found' }
						}
						return this.todos.snapshot()
					},
				)
				.delete('/todos/:id', ({ params, set }) => {
					if (!this.todos.remove(params.id)) {
						set.status = 404
						return { error: 'todo-not-found' }
					}
					return this.todos.snapshot()
				}),
		)
	}
}
