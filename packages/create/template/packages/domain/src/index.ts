export const TODO_TITLE_MAX_LENGTH = 80

export type TodoItem = Readonly<{
	id: string
	title: string
	completed: boolean
}>

export function normalizeTodoTitle(title: string): string {
	const normalized = title.trim().replaceAll(/\s+/g, ' ')
	if (!normalized) throw new TypeError('Todo title cannot be empty')
	if (normalized.length > TODO_TITLE_MAX_LENGTH) {
		throw new RangeError(`Todo title cannot exceed ${TODO_TITLE_MAX_LENGTH} characters`)
	}
	return normalized
}

export function withTodoCompletion(todo: TodoItem, completed: boolean): TodoItem {
	return { ...todo, completed }
}
