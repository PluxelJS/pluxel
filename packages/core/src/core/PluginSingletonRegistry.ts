type ChangeSummary<K, V> = {
	added: Map<K, V>
	deleted: Set<K>
	updated: Map<K, { oldValue: V; newValue: V }>
}

export class PluginSingletonRegistry<K, V> {
	// 正式状态
	private current = new Map<K, V>()

	// 草稿阶段
	private draft!: Map<K, V>
	private added = new Set<K>()
	private deleted = new Set<K>()
	private updated = new Map<K, { oldValue: V; newValue: V }>()

	constructor() {
		this.resetDraft()
	}

	private resetDraft() {
		this.draft = new Map(this.current)
		this.added.clear()
		this.deleted.clear()
		this.updated.clear()
	}

	/** 草稿阶段设置或覆盖 */
	set(key: K, value: V) {
		if (!this.current.has(key)) {
			// 新增
			this.added.add(key)
		} else {
			const old = this.current.get(key)!
			if (old !== value) {
				// 更新
				this.updated.set(key, { oldValue: old, newValue: value })
			}
		}
		// 如果之前标记为 deleted，要撤销删除
		this.deleted.delete(key)
		this.draft.set(key, value)
	}

	/** 草稿阶段删除 */
	delete(key: K) {
		if (this.current.has(key)) {
			this.deleted.add(key)
		}
		// 如果之前在这轮草稿里新加了，就撤销新增
		this.added.delete(key)
		this.updated.delete(key)
		this.draft.delete(key)
	}

	/** 获取当前草稿 Map，用于 build 时传入 outsideSingletons */
	getMap() {
		return this.draft
	}

	/**
	 * 把草稿合并到正式状态，并返回本轮所有改动
	 */
	commit(): ChangeSummary<K, V> {
		// 先把 draft 变成 current
		this.current = new Map(this.draft)

		// 组装改动摘要
		const addedMap = new Map<K, V>()
		for (const k of this.added) {
			addedMap.set(k, this.current.get(k)!)
		}

		const deletedSet = new Set<K>(this.deleted)

		const updatedMap = new Map<K, { oldValue: V; newValue: V }>(this.updated)

		// 重置，为下一轮 draft 做准备
		this.resetDraft()

		return { added: addedMap, deleted: deletedSet, updated: updatedMap }
	}
}
