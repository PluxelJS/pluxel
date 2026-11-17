import type { Context } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/host'

/** Per-run member admission; native values returned by business APIs keep their own lifecycle. */
export function createBorrowedValueView(
	raw: object,
	owner: Context,
	options: Readonly<{
		signal: AbortSignal
		assertOpen(): void
		begin(): void
		end(): void
		track(task: Promise<unknown>): void
		unwrap(value: unknown): unknown
	}>,
): object {
	const methods = new Map<PropertyKey, { original: Function; wrapped: Function }>()
	let view: object
	const invoke = (work: () => unknown): unknown => {
		options.assertOpen()
		const lease = enterOwnerInvocation(owner, options.signal)
		options.begin()
		let released = false
		const release = () => {
			if (released) return
			released = true
			lease.dispose()
			options.end()
		}
		try {
			const value = work()
			if (value === raw) {
				release()
				return view
			}
			if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
				// Use the intrinsic brand check; never read a business object's `then`.
				// A base Promise side chain keeps custom Promise subclasses out of SDK internals.
				let resolveTracked!: () => void
				let rejectTracked!: (error: unknown) => void
				const tracked = new Promise<void>((resolve, reject) => {
					resolveTracked = resolve
					rejectTracked = reject
				})
				try {
					Promise.prototype.then.call(
						value,
						() => {
							release()
							resolveTracked()
						},
						(error: unknown) => {
							release()
							rejectTracked(error)
						},
					)
				} catch (error) {
					resolveTracked()
					// A known native Promise can fail here because its custom species
					// rejects reaction registration. Preserve that unsupported protocol's
					// error instead of silently treating it as an untracked business value.
					if (value instanceof Promise) throw error
					release()
					return value
				}
				options.track(tracked)
				return value
			}
			release()
			return value
		} catch (error) {
			release()
			throw error
		}
	}
	// A separate extensible shell permits admitted method wrappers even when the
	// provider has readonly/non-configurable own methods. A bound function has no
	// fixed own prototype/caller/arguments keys that would constrain Proxy reflection.
	const shell =
		typeof raw === 'function'
			? Function.prototype.bind.call(function () {}, undefined)
			: Object.create(Object.getPrototypeOf(raw))
	view = new Proxy(shell, {
		apply(_target, receiver, args) {
			return invoke(() =>
				Reflect.apply(raw as Function, options.unwrap(receiver), args.map(options.unwrap)),
			)
		},
		construct(_target, args, newTarget) {
			return invoke(() =>
				Reflect.construct(
					raw as Function,
					args.map(options.unwrap),
					newTarget === view ? (raw as Function) : newTarget,
				),
			) as object
		},
		get(_target, key, receiver) {
			const value = invoke(() =>
				Reflect.get(raw, key, receiver === view ? raw : options.unwrap(receiver)),
			)
			if (typeof value !== 'function') return value
			const cached = methods.get(key)
			if (cached?.original === value) return cached.wrapped
			const wrapped: Function = new Proxy(value, {
				apply(_method, callReceiver, args) {
					return invoke(() =>
						Reflect.apply(
							value,
							// A bound callable must keep targeting the admitted view. Binding
							// the native provider would let the returned function outlive it.
							typeof raw === 'function' && value === Function.prototype.bind
								? callReceiver
								: options.unwrap(callReceiver),
							args.map(options.unwrap),
						),
					)
				},
				construct(_constructor, args, newTarget) {
					return invoke(() =>
						Reflect.construct(
							value,
							args.map(options.unwrap),
							newTarget === wrapped ? value : newTarget,
						),
					) as object
				},
			})
			methods.set(key, { original: value, wrapped })
			return wrapped
		},
		set(_target, key, value, receiver) {
			return invoke(() =>
				Reflect.set(
					raw,
					key,
					options.unwrap(value),
					receiver === view ? raw : options.unwrap(receiver),
				),
			) as boolean
		},
		has(_target, key) {
			return invoke(() => Reflect.has(raw, key)) as boolean
		},
		ownKeys() {
			return invoke(() => Reflect.ownKeys(raw)) as (string | symbol)[]
		},
		getOwnPropertyDescriptor(_target, key) {
			return invoke(() => {
				const descriptor = Reflect.getOwnPropertyDescriptor(raw, key)
				if (!descriptor) return undefined
				return 'value' in descriptor
					? {
							configurable: true,
							enumerable: descriptor.enumerable,
							writable: descriptor.writable,
							value: Reflect.get(view, key),
						}
					: {
							configurable: true,
							enumerable: descriptor.enumerable,
							get:
								descriptor.get === undefined
									? undefined
									: function (this: unknown) {
											return invoke(() => Reflect.get(raw, key, options.unwrap(this)))
										},
							set:
								descriptor.set === undefined
									? undefined
									: function (this: unknown, value: unknown) {
											invoke(() =>
												Reflect.set(raw, key, options.unwrap(value), options.unwrap(this)),
											)
										},
						}
			}) as PropertyDescriptor | undefined
		},
		defineProperty() {
			throw new TypeError('Borrowed value views do not support redefining properties')
		},
		deleteProperty() {
			throw new TypeError('Borrowed value views do not support deleting properties')
		},
		preventExtensions() {
			throw new TypeError('Borrowed value views cannot be frozen')
		},
		setPrototypeOf() {
			throw new TypeError('Borrowed value views cannot change prototype')
		},
	})
	return view
}
