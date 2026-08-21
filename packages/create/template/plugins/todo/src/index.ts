import { normalizeTodoTitle, withTodoCompletion, type TodoItem } from '@example/domain'
import type { AuditPlugin } from '@example/audit-plugin'
import { BasePlugin, definePluginRef, Plugin, v } from '@pluxel/runtime'

const TodoConfig = v.object({
	maxItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 20),
	seedTitle: v.optional(v.string(), 'Explore the Pluxel starter'),
})

const Audit = definePluginRef<AuditPlugin>()

export type TodoSnapshot = Readonly<{
	items: readonly TodoItem[]
	maxItems: number
	auditEnabled: boolean
}>

export type AddTodoResult =
	| Readonly<{ ok: true; item: TodoItem }>
	| Readonly<{ ok: false; reason: 'limit-reached' }>

@Plugin({ displayName: 'Example todos' })
export class TodoPlugin extends BasePlugin {
	readonly config = this.configs.use(TodoConfig)
	private readonly items = new Map<string, TodoItem>()
	private audit: AuditPlugin | undefined
	private nextId = 1

	override init(): void {
		this.plugins.use(Audit, (audit) => {
			this.audit = audit
			return () => {
				this.audit = undefined
			}
		})
		this.add(this.config.seedTitle)
	}

	snapshot(): TodoSnapshot {
		return {
			items: Array.from(this.items.values(), ({ id, title, completed }) => ({
				id,
				title,
				completed,
			})),
			maxItems: this.config.maxItems,
			auditEnabled: this.audit !== undefined,
		}
	}

	add(title: string): AddTodoResult {
		if (this.items.size >= this.config.maxItems) return { ok: false, reason: 'limit-reached' }
		const item: TodoItem = {
			id: `todo-${this.nextId++}`,
			title: normalizeTodoTitle(title),
			completed: false,
		}
		this.items.set(item.id, item)
		this.audit?.record(`todo.added:${item.id}`)
		return { ok: true, item: { ...item } }
	}

	setCompleted(id: string, completed: boolean): TodoItem | undefined {
		const current = this.items.get(id)
		if (!current) return undefined
		const next = withTodoCompletion(current, completed)
		this.items.set(id, next)
		this.audit?.record(`todo.completed:${id}:${completed}`)
		return { ...next }
	}

	remove(id: string): boolean {
		const removed = this.items.delete(id)
		if (removed) this.audit?.record(`todo.removed:${id}`)
		return removed
	}
}
