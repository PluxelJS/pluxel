/** A compile-once, run-many dependency graph. No runtime dependencies. */
declare const valueType: unique symbol

/** An immutable, graph-local reference. This is a recipe, not a Promise. */
export interface Ref<T> {
	readonly [valueType]: T
}

type RefMap = Readonly<Record<PropertyKey, Ref<unknown>>>
type OutputMap = RefMap & { readonly then?: never }
type Values<D> = { -readonly [K in keyof D]: D[K] extends Ref<infer T> ? T : never }

export interface CompileOptions {
	/** On failure: reject early (default), or first wait for every started graph task. */
	readonly failure?: 'early' | 'drain'
}

export interface Graph<Input> {
	/** The resolved input of the current invocation; never shared between runs. */
	readonly input: Ref<Awaited<Input>>

	/** Dependencies are named references. The callback receives their resolved values. */
	task<const D extends RefMap, R>(dependencies: D, run: (values: Values<D>) => R): Ref<Awaited<R>>

	/** Select exactly the result to compute. Only its ancestors will execute. */
	compile<T>(output: Ref<T>, options?: CompileOptions): (input: Input) => Promise<T>
	compile<const D extends OutputMap>(
		outputs: D,
		options?: CompileOptions,
	): (input: Input) => Promise<Values<D>>
}

// A non-plain prototype distinguishes foreign references from an empty output map,
// including references created by another copy of this module.
class Token<T> implements Ref<T> {
	declare readonly [valueType]: T
}

type Definition = {
	keys: PropertyKey[]
	dependencies: number[]
	invoke: (values: Record<PropertyKey, unknown>) => unknown
}

function ownKeys(value: unknown): PropertyKey[] {
	if (value === null || typeof value !== 'object') {
		throw new TypeError('grfn: expected a reference or a plain reference map')
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(
			'grfn: expected a plain reference map; references must belong to this graph',
		)
	}
	return Reflect.ownKeys(value)
}

function record(
	keys: readonly PropertyKey[],
	values: readonly unknown[],
): Record<PropertyKey, unknown> {
	// Object.fromEntries safely handles __proto__, constructor, numbers and symbols.
	return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
}

// Keep the runner outside the builder's scope: it closes over the selected plan,
// not the builder's full definitions/reference registry.
function createRunner<Input>(
	plan: readonly Definition[],
	outputSlots: readonly number[],
	outputKeys: readonly PropertyKey[] | undefined,
	usesInput: boolean,
	drain: boolean,
): (input: Input) => Promise<unknown> {
	const empty = Promise.resolve()
	return (value: Input): Promise<unknown> => {
		const promises: Promise<unknown>[] = []
		promises.length = plan.length + 1
		if (usesInput) promises[0] = Promise.resolve(value)
		for (let slot = 0; slot < plan.length; slot++) {
			const step = plan[slot]!
			const deps = step.dependencies
			if (deps.length === 0) {
				promises[slot + 1] = empty.then(() => step.invoke({}))
			} else if (deps.length === 1) {
				promises[slot + 1] = promises[deps[0]!]!.then((dependencyValue) =>
					step.invoke(record(step.keys, [dependencyValue])),
				)
			} else {
				promises[slot + 1] = Promise.all(deps.map((dep) => promises[dep]!)).then((values) =>
					step.invoke(record(step.keys, values)),
				)
			}
		}
		// All rejection handlers are wired before any task callback starts.
		// Unrelated branches may continue after rejection: this is not cancellation.
		const result =
			outputKeys === undefined
				? promises[outputSlots[0]!]!
				: Promise.all(outputSlots.map((slot) => promises[slot]!)).then((values) =>
						record(outputKeys, values),
					)
		return drain
			? result.catch(async (reason) => {
					await Promise.allSettled(promises)
					throw reason
				})
			: result
	}
}

/** Create the graph once, declare tasks, then compile one or more output selections. */
export function grfn<Input = void>(): Graph<Input> {
	const input = Object.freeze(new Token<Awaited<Input>>())
	const indices = new WeakMap<object, number>([[input, 0]])
	const definitions: Definition[] = []

	function indexOf(reference: unknown, key: PropertyKey): number {
		const index =
			reference !== null && typeof reference === 'object' ? indices.get(reference) : undefined
		if (index === undefined) {
			throw new TypeError(`grfn: dependency ${String(key)} is not a reference from this graph`)
		}
		return index
	}

	function task<const D extends RefMap, R>(
		dependencies: D,
		run: (values: Values<D>) => R,
	): Ref<Awaited<R>> {
		if (typeof run !== 'function') throw new TypeError('grfn: task callback must be a function')
		const keys = ownKeys(dependencies)
		const deps = keys.map((key) => indexOf(dependencies[key], key))
		const reference = Object.freeze(new Token<Awaited<R>>())
		// Types are erased only here; each edge was checked against its reference.
		definitions.push({ keys, dependencies: deps, invoke: (values) => run(values as Values<D>) })
		indices.set(reference, definitions.length)
		return reference
	}

	function compile<T>(output: Ref<T>, options?: CompileOptions): (input: Input) => Promise<T>
	function compile<const D extends OutputMap>(
		outputs: D,
		options?: CompileOptions,
	): (input: Input) => Promise<Values<D>>
	function compile(
		output: Ref<unknown> | RefMap,
		options: CompileOptions = {},
	): (input: Input) => Promise<unknown> {
		const { failure = 'early' } = options
		if (failure !== 'early' && failure !== 'drain')
			throw new TypeError('grfn: invalid failure policy')
		const singleIndex =
			output !== null && typeof output === 'object' ? indices.get(output) : undefined
		const single = singleIndex !== undefined
		const keys = single ? [] : ownKeys(output)
		// Promise resolution treats a callable .then as a thenable, not a record.
		// Reserve the key consistently, instead of silently hanging on function-valued outputs.
		if (keys.includes('then'))
			throw new TypeError('grfn: output key "then" is reserved; use an alias')
		const selected = single
			? [singleIndex]
			: keys.map((key) => indexOf((output as RefMap)[key], key))

		// Iterative DFS visits only selected ancestors, even if the builder has many
		// unrelated definitions. Postorder gives a topological plan; no recursion.
		let usesInput = selected.includes(0)
		const slots = new Map<number, number>([[0, 0]])
		const plan: Definition[] = []
		for (const root of selected) {
			const stack = [{ id: root, edge: 0 }]
			while (stack.length > 0) {
				const frame = stack[stack.length - 1]!
				if (slots.has(frame.id)) {
					stack.pop()
					continue
				}
				const definition = definitions[frame.id - 1]!
				if (frame.edge < definition.dependencies.length) {
					const id = definition.dependencies[frame.edge++]!
					if (id === 0) usesInput = true
					if (!slots.has(id)) stack.push({ id, edge: 0 })
				} else {
					slots.set(frame.id, plan.length + 1)
					plan.push({
						keys: definition.keys,
						dependencies: definition.dependencies.map((dep) => slots.get(dep)!),
						invoke: definition.invoke,
					})
					stack.pop()
				}
			}
		}
		const outputSlots = selected.map((id) => slots.get(id)!)

		return createRunner<Input>(
			plan,
			outputSlots,
			single ? undefined : keys,
			usesInput,
			failure === 'drain',
		)
	}

	return Object.freeze({ input, task, compile })
}
