import { describe, expect, it } from 'vitest'
import { normalizeTodoTitle, withTodoCompletion } from '@example/domain'

describe('todo domain', () => {
	it('normalizes titles without involving a Plugin host', () => {
		expect(normalizeTodoTitle('  Learn   Pluxel  ')).toBe('Learn Pluxel')
	})

	it('returns a new immutable-style value when completion changes', () => {
		const todo = { id: 'todo-1', title: 'Write a Plugin', completed: false }
		const completed = withTodoCompletion(todo, true)

		expect(completed).toEqual({ ...todo, completed: true })
		expect(todo.completed).toBe(false)
	})
})
