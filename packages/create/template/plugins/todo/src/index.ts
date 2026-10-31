import { normalizeTodoTitle, type TodoItem } from '@example/domain'
import type { AuditPlugin } from '@example/audit-plugin'
import { BasePlugin, definePluginRef, Plugin } from '@pluxel/core'
import { TinyBase } from '@pluxel/services/tinybase'
import { createStore, type Store } from 'tinybase'
import * as v from 'valibot'

export const TodoConfig = v.object({
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
	private readonly config = this.configs.use(TodoConfig)
	private store?: Store
	private audit: AuditPlugin | undefined

	protected override async init(): Promise<void> {
		// These initial values apply only when the Host has no snapshot for this node.
		const initial = createStore()
			.setValues({ initialized: true, nextId: 2 })
			.setRow('todos', 'todo-1', {
				title: normalizeTodoTitle(this.config.seedTitle),
				completed: false,
			})
		const store = await this.ctx.require(TinyBase).open(initial)
		validateTodos(store)
		this.store = store
		this.plugins.use(Audit, (audit) => {
			this.audit = audit
			return () => {
				this.audit = undefined
			}
		})
	}

	snapshot(): TodoSnapshot {
		return {
			items: Object.entries(this.requireStore().getTable('todos')).map(([id, row]) => ({
				id,
				...v.parse(TodoRow, row),
			})),
			maxItems: this.config.maxItems,
			auditEnabled: this.audit !== undefined,
		}
	}

	/** Native mutations update memory now; the Host saves and drains the Store. */
	add(title: string): AddTodoResult {
		const store = this.requireStore()
		if (store.getRowIds('todos').length >= this.config.maxItems) {
			return { ok: false, reason: 'limit-reached' }
		}
		const nextId = store.getValue('nextId') ?? 1
		if (typeof nextId !== 'number' || !Number.isSafeInteger(nextId) || nextId < 1) {
			throw new TypeError('Todo nextId must be a positive safe integer')
		}
		if (nextId >= Number.MAX_SAFE_INTEGER) throw new RangeError('Todo IDs are exhausted')
		const item: TodoItem = {
			id: `todo-${nextId}`,
			title: normalizeTodoTitle(title),
			completed: false,
		}
		store.transaction(() => {
			store.setRow('todos', item.id, { title: item.title, completed: item.completed })
			store.setValues({ initialized: true, nextId: nextId + 1 })
		})
		this.audit?.record(`todo.added:${item.id}`)
		return { ok: true, item: { ...item } }
	}

	setCompleted(id: string, completed: boolean): TodoItem | undefined {
		if (typeof completed !== 'boolean') throw new TypeError('Todo completion must be boolean')
		const store = this.requireStore()
		if (!store.hasRow('todos', id)) return undefined
		const item = v.parse(TodoRow, store.getRow('todos', id))
		store.setCell('todos', id, 'completed', completed)
		this.audit?.record(`todo.completed:${id}:${completed}`)
		return { id, title: item.title, completed }
	}

	remove(id: string): boolean {
		const store = this.requireStore()
		if (!store.hasRow('todos', id)) return false
		store.delRow('todos', id)
		this.audit?.record(`todo.removed:${id}`)
		return true
	}

	private requireStore(): Store {
		if (!this.store) throw new Error('TodoPlugin is not initialized')
		return this.store
	}
}

const TodoRow = v.strictObject({ title: v.string(), completed: v.boolean() })

function validateTodos(store: Store): void {
	if (store.getTableIds().some((id) => id !== 'todos')) {
		throw new TypeError('Todo state contains an unknown table')
	}
	const values = store.getValues()
	const rows = Object.entries(store.getTable('todos'))
	// A restored empty snapshot remains empty; it never replays the seed.
	if (!Object.keys(values).length && !rows.length) return
	if (
		Object.keys(values).length !== 2 ||
		values.initialized !== true ||
		typeof values.nextId !== 'number' ||
		!Number.isSafeInteger(values.nextId) ||
		values.nextId < 1
	) {
		throw new TypeError('Todo state requires initialized and a positive nextId')
	}
	if (rows.length > 100) throw new RangeError('Todo state exceeds its 100 item limit')
	for (const [id, row] of rows) {
		const value = v.parse(TodoRow, row)
		const index = Number(id.slice('todo-'.length))
		if (!/^todo-[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(index) || index >= values.nextId) {
			throw new TypeError('Todo row ID is inconsistent with nextId')
		}
		if (normalizeTodoTitle(value.title) !== value.title) {
			throw new TypeError('Stored Todo titles must be normalized')
		}
	}
}
