type OpType = 'add' | 'remove' | 'replace'
interface Op<K, V> {
	type: OpType
	key: K
	oldValue?: V
	newValue?: V
}

export class LeanMapTracker<K, V> extends Map<K, V> {
	public pendingOps: Op<K, V>[] = []
	private undoStack: Op<K, V>[] = []
	private redoStack: Op<K, V>[] = []

	constructor(entries?: readonly (readonly [K, V])[] | null) {
		super(entries ?? [])
	}

	override set(key: K, value: V): this {
		const has = this.has(key)
		const oldValue = this.get(key)
		const op: Op<K, V> = {
			type: has ? 'replace' : 'add',
			key,
			oldValue,
			newValue: value,
		}
		// 调用父类方法，更新内部 Map
		super.set(key, value)
		this.record(op)
		return this
	}

	override delete(key: K): boolean {
		if (!this.has(key)) return false
		const oldValue = this.get(key)!
		// 先记录，再删
		const op: Op<K, V> = { type: 'remove', key, oldValue }
		super.delete(key)
		this.record(op)
		return true
	}

	override clear(): void {
		// 记录每个 remove
		for (const [key, oldValue] of this.entries()) {
			this.record({ type: 'remove', key, oldValue })
		}
		super.clear()
	}

	/** 内部：记录并同步 undo/redo 栈 */
	private record(op: Op<K, V>) {
		this.pendingOps.push(op)
		this.undoStack.push(op)
		this.redoStack = [] // 新操作后清空 redo 历史
	}

	/** 一次性获取自上次 commit 以来的所有操作 */
	commit(): Op<K, V>[] {
		const ops = this.pendingOps.slice()
		this.pendingOps = []
		return ops
	}

	/** 回滚到上次 commit 时状态 */
	reset(): void {
		// 反向执行 undoStack
		for (let i = this.undoStack.length - 1; i >= 0; i--) {
			const { type, key, oldValue } = this.undoStack[i]
			switch (type) {
				case 'add':
					super.delete(key)
					break
				case 'remove':
					super.set(key, oldValue!)
					break
				case 'replace':
					super.set(key, oldValue!)
					break
			}
		}
		// 准备 redo
		this.redoStack = this.undoStack.slice()
		this.undoStack = []
		this.pendingOps = []
	}

	/** 如果刚 reset，可用 redo 恢复到 reset 之前状态 */
	redo(): void {
		for (const { type, key, newValue } of this.redoStack) {
			switch (type) {
				case 'add':
					super.set(key, newValue!)
					break
				case 'remove':
					super.delete(key)
					break
				case 'replace':
					super.set(key, newValue!)
					break
			}
		}
		this.redoStack = []
	}
}
