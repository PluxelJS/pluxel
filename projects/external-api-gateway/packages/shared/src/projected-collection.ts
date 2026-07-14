type IdDocument = { id: string }

type FindOptions<T> = {
	limit?: number
	sort?: Partial<Record<keyof T, 1 | -1>>
}

/**
 * Business-owned collection with an optional Workbench Plane projection.
 *
 * Runtime code always reads and writes the local collection. Attaching a workbench
 * collection mirrors the current snapshot and future mutations without making the
 * business capability depend on the optional workbench backend.
 */
export class ProjectedCollection<T extends IdDocument> {
	readonly #documents = new Map<string, T>()
	readonly #listeners = new Set<() => void>()

	snapshot(): T[] {
		return structuredClone([...this.#documents.values()])
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	findOne(filter: Pick<T, 'id'>): T | undefined {
		const document = this.#documents.get(filter.id)
		return document ? structuredClone(document) : undefined
	}

	find(_filter: Record<string, never>, options: FindOptions<T> = {}): T[] {
		let documents = [...this.#documents.values()]
		const sort = options.sort
		if (sort) {
			const entries = Object.entries(sort) as Array<[keyof T, 1 | -1]>
			documents.sort((left, right) => compareDocuments(left, right, entries))
		}
		if (options.limit !== undefined) documents = documents.slice(0, options.limit)
		return structuredClone(documents)
	}

	count(): number {
		return this.#documents.size
	}

	insert(document: T): void {
		if (this.#documents.has(document.id)) throw new Error(`Duplicate document id: ${document.id}`)
		const next = structuredClone(document)
		this.#documents.set(document.id, next)
		this.#notify()
	}

	replaceOne(filter: Pick<T, 'id'>, document: T, options: { upsert?: boolean } = {}): void {
		if (!this.#documents.has(filter.id) && !options.upsert) return
		if (filter.id !== document.id) {
			throw new TypeError(
				`Replacement document id ${JSON.stringify(document.id)} does not match ${JSON.stringify(filter.id)}`,
			)
		}
		const next = structuredClone(document)
		this.#documents.set(filter.id, next)
		this.#notify()
	}

	removeOne(filter: Pick<T, 'id'>): void {
		if (!this.#documents.delete(filter.id)) return
		this.#notify()
	}

	removeMany(_filter: Record<string, never>): void {
		if (this.#documents.size === 0) return
		this.#documents.clear()
		this.#notify()
	}

	#notify(): void {
		for (const listener of this.#listeners) listener()
	}
}

function compareDocuments<T>(left: T, right: T, entries: Array<[keyof T, 1 | -1]>): number {
	for (const [key, direction] of entries) {
		const order = compareValues(left[key], right[key])
		if (order !== 0) return order * direction
	}
	return 0
}

function compareValues(left: unknown, right: unknown): number {
	if (left === right) return 0
	if (left === undefined || left === null) return 1
	if (right === undefined || right === null) return -1
	if (typeof left === 'number' && typeof right === 'number') return left - right
	return String(left).localeCompare(String(right))
}
