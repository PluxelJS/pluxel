const CONTEXT_HOST_TYPE: unique symbol = Symbol('pluxel.context.host')
const CONTEXT_PLAN_TYPE: unique symbol = Symbol('pluxel.context.plan')
const CONTEXT_INSTALLATION_TYPE: unique symbol = Symbol('pluxel.context.installation')
const CONTEXT_TYPE: unique symbol = Symbol('pluxel.context.type')
const ROOT_CONTEXT_TYPE: unique symbol = Symbol('pluxel.context.root-type')
const SERVICE_TYPE: unique symbol = Symbol('pluxel.context.service')
const SERVICE_REF_TYPE: unique symbol = Symbol('pluxel.context.service-ref')
const CONSTRUCTING = Symbol('pluxel.context.constructing')
const EMPTY_OWNER_VALUES: unknown[] = Object.freeze([]) as unknown as unknown[]

export type ServiceAccess = 'all' | 'owner' | 'root'
export type ServiceScope = 'root' | 'scope' | 'owner-view'
export type ServiceClass<T = any, A extends ServiceAccess = 'all'> = (abstract new (
	...args: any[]
) => T) &
	Readonly<{ access?: A }>

/** A required service declaration. A class is its declaration, never an instruction to construct it. */
export type ServiceDefinition<T = any, A extends ServiceAccess = 'all'> =
	| ServiceClass<T, A>
	| Readonly<{ access: A; [SERVICE_TYPE]: (value: T) => T }>

/** An optional reference to the same installed definition, not another service declaration. */
export interface ServiceRef<T, A extends ServiceAccess = ServiceAccess> {
	readonly access: A
	readonly [SERVICE_REF_TYPE]: (value: T) => T
}

type AnyDefinition = ServiceDefinition<any, ServiceAccess>
type AnyTarget = AnyDefinition | ServiceRef<any>
export type ServiceKey = object | string

type ReferenceRecord = Readonly<{ key: ServiceKey; access: ServiceAccess; optional: boolean }>
const REFERENCES = new WeakMap<object, ReferenceRecord>()
const CLASS_REFERENCES = new WeakMap<object, ReferenceRecord>()
const IDENTITIES = new WeakMap<object, ServiceKey>()

/** Opaque fixed-plan input. Installation factories are synchronous and strictly lazy. */
export interface ServiceInstallation<
	T = any,
	S extends ServiceScope = ServiceScope,
	A extends ServiceAccess = ServiceAccess,
> {
	readonly [CONTEXT_INSTALLATION_TYPE]: Readonly<{ value: T; scope: S; access: A }>
}
export type RootServiceInstallation<T = any> = ServiceInstallation<T, 'root'>
export type ScopeServiceInstallation<
	T = any,
	A extends ServiceAccess = ServiceAccess,
> = ServiceInstallation<T, 'scope', A>
export interface OwnerViewServiceInstallation<
	B = any,
	T = any,
	A extends ServiceAccess = ServiceAccess,
> extends ServiceInstallation<T, 'owner-view', A> {
	readonly [SERVICE_TYPE]: B
}

export interface Context<TRoot extends RootContext<any> = RootContext> {
	readonly [CONTEXT_TYPE]: true
	service<T>(definition: ServiceDefinition<T, 'all'>): T
	service<T>(
		definition: ServiceDefinition<T, 'root'> &
			(this extends { readonly [ROOT_CONTEXT_TYPE]: true } ? unknown : never),
	): T
	service<T>(
		definition: ServiceDefinition<T, 'owner'> &
			(this extends { readonly [ROOT_CONTEXT_TYPE]: true } ? never : unknown),
	): T
	service<T>(ref: ServiceRef<T>): T | undefined
	readonly root: TRoot
	readonly parent?: Context<TRoot>
	readonly name: string
	readonly [Symbol.toStringTag]: 'PluxelContext'
}
export interface RootContext<
	TRoot extends RootContext<any> = RootContext<any>,
> extends Context<TRoot> {
	readonly [ROOT_CONTEXT_TYPE]: true
}
export interface ContextHost<
	TContext extends Context<any> = Context,
	TRoot extends RootContext<any> = RootContext,
> {
	readonly [CONTEXT_HOST_TYPE]: Readonly<{ context: TContext; root: TRoot }>
	readonly name: string
	createRoot(name?: string): TRoot
	createScope(root: TRoot, name: string): TContext
	createChild(parent: TContext, name: string): TContext
}
export type ContextOf<H extends ContextHost<any, any>> =
	H extends ContextHost<infer C, any> ? C : never
export type RootContextOf<H extends ContextHost<any, any>> =
	H extends ContextHost<any, infer R> ? R : never
export type ContextHostOptions<
	TServices extends readonly ServiceInstallation[] = readonly ServiceInstallation[],
> = Readonly<{
	name: string
	services: TServices
	overrides?: readonly TServices[number][]
}>

type RootOptions<T> = Readonly<{ access?: 'all' | 'root'; create(ctx: RootContext): T }>
type ScopeOptions<T, A extends ServiceAccess> = Readonly<{ access?: A; create(ctx: Context): T }>
type OwnerOptions<B, T, A extends ServiceAccess> = Readonly<{
	access?: A
	createRoot(root: RootContext): B
	createView(backing: B, owner: Context): T
}>
type CompiledInstallation = Readonly<{
	definition: AnyDefinition
	key: ServiceKey
	access: ServiceAccess
	scope: ServiceScope
	create?: (ctx: any) => unknown
	createRoot?: (ctx: RootContext) => unknown
	createView?: (backing: unknown, owner: Context) => unknown
}>
type Resolver = (state: ContextState, ctx: Context) => unknown
type InstalledService = Readonly<{
	definition: AnyDefinition
	access: ServiceAccess
	scope: ServiceScope
	resolve: Resolver
}>
export type ContextPlan = Readonly<{ readonly [CONTEXT_PLAN_TYPE]: true }>
type CompiledPlan = Readonly<{
	name: string
	services: ReadonlyMap<ServiceKey, InstalledService>
	definitions: readonly AnyDefinition[]
}>
type ContextState = {
	serviceValues?: ReadonlyMap<ServiceKey, unknown>
	servicesRead?: boolean
	readonly plan: CompiledPlan
	readonly root: RootContext
	readonly scope: Context
	readonly parent?: Context
	readonly name: string
	readonly rootValues: unknown[]
	readonly scopeValues: unknown[]
	ownerValues: unknown[]
}
const INSTALLATIONS = new WeakMap<object, CompiledInstallation>()
const PLANS = new WeakMap<object, CompiledPlan>()
let readState!: (ctx: Context) => ContextState
let initializeState!: (ctx: Context, state: ContextState) => void
class ContextImpl {
	#state?: ContextState
	static {
		readState = (ctx) => {
			if (isObject(ctx) && #state in ctx) {
				const state = (ctx as unknown as ContextImpl).#state
				if (state) return state
			}
			throw invalidContextError(ctx)
		}
		initializeState = (ctx, state) => {
			if (!isObject(ctx) || !(#state in ctx)) throw invalidContextError(ctx)
			const implementation = ctx as unknown as ContextImpl
			if (implementation.#state)
				throw new TypeError('[pluxel/context] Context is already initialized')
			implementation.#state = state
		}
	}
	service<T>(target: ServiceDefinition<T, ServiceAccess> | ServiceRef<T>): T | undefined {
		const ctx = this as unknown as Context
		const state = readState(ctx)
		state.servicesRead = true
		const reference = readTarget(target)
		assertAccess(state, ctx, reference.access, describeTarget(target))
		const installed = state.plan.services.get(reference.key)
		if (!installed) {
			if (reference.optional) return undefined
			throw new ContextServiceMissingError(describeTarget(target), state.plan.name)
		}
		assertAccess(
			state,
			ctx,
			installed.access,
			describeTarget(installed.definition),
			installed.scope,
		)
		return (
			state.serviceValues?.has(reference.key)
				? state.serviceValues.get(reference.key)
				: installed.resolve(state, ctx)
		) as T
	}
	get root(): RootContext {
		return this.#state!.root
	}
	get parent(): Context | undefined {
		return this.#state!.parent
	}
	get name(): string {
		return this.#state!.name
	}
	get [Symbol.toStringTag](): 'PluxelContext' {
		return 'PluxelContext'
	}
}
Object.defineProperty(ContextImpl.prototype, 'constructor', {
	value: undefined,
	writable: false,
	configurable: false,
})
Object.freeze(ContextImpl.prototype)

export class ContextServiceMissingError extends Error {
	readonly code = 'CONTEXT_SERVICE_MISSING'
	constructor(
		readonly service: string,
		readonly host: string,
	) {
		super(`[pluxel/context] Context host ${host} does not install ${service}`)
		this.name = 'ContextServiceMissingError'
	}
}
export class ContextServiceAccessError extends Error {
	readonly code = 'CONTEXT_SERVICE_ACCESS_DENIED'
	constructor(readonly service: string) {
		super(`[pluxel/context] Service ${service} is not available through service() in this Context`)
		this.name = 'ContextServiceAccessError'
	}
}

export function installRootService<T>(
	definition: ServiceDefinition<T, ServiceAccess>,
	options: RootOptions<NoInfer<T>>,
): RootServiceInstallation<T> {
	return installation(definition, 'root', options)
}
export function installScopeService<T, A extends ServiceAccess = ServiceAccess>(
	definition: ServiceDefinition<T, A>,
	options: ScopeOptions<NoInfer<T>, A>,
): ScopeServiceInstallation<T, A> {
	return installation(definition, 'scope', options)
}
export function installOwnerViewService<B, T, A extends ServiceAccess = ServiceAccess>(
	definition: ServiceDefinition<T, A>,
	options: OwnerOptions<B, NoInfer<T>, A>,
): OwnerViewServiceInstallation<B, T, A> {
	return installation(definition, 'owner-view', options)
}
function installation<T extends ServiceInstallation>(
	definition: AnyDefinition,
	scope: ServiceScope,
	options: any,
): T {
	const target = readRequired(definition)
	const access = options?.access ?? target.access
	assertServiceAccess(access)
	if ((scope === 'root' && access === 'owner') || (scope !== 'root' && access === 'root')) {
		throw new TypeError(
			`[pluxel/context] Service ${describeTarget(definition)} has an incompatible installation scope`,
		)
	}
	const factories = scope === 'owner-view' ? ['createRoot', 'createView'] : ['create']
	for (const name of factories)
		if (typeof options?.[name] !== 'function') {
			throw new TypeError(
				`[pluxel/context] Service ${describeTarget(definition)} requires a ${name} factory`,
			)
		}
	const value = Object.freeze({}) as T
	// Installation fixes the lookup identity; a later binder must never invalidate a compiled plan.
	IDENTITIES.set(definition, target.key)
	INSTALLATIONS.set(
		value,
		Object.freeze({
			definition,
			key: target.key,
			access,
			scope,
			...(scope === 'owner-view'
				? { createRoot: options.createRoot, createView: options.createView }
				: { create: options.create }),
		}),
	)
	return value
}
export function getServiceInstallationDefinition(value: ServiceInstallation): AnyDefinition {
	return installationRecord(value).definition
}
/** Preparation dependencies deliberately resolve an installed service without a public owner-access check. */
export function resolveContextService<T>(
	ctx: Context,
	definition: ServiceDefinition<T, ServiceAccess>,
): T {
	const state = readState(ctx)
	state.servicesRead = true
	const target = readRequired(definition)
	const installed = state.plan.services.get(target.key)
	if (!installed) throw new ContextServiceMissingError(describeTarget(definition), state.plan.name)
	return (
		state.serviceValues?.has(target.key)
			? state.serviceValues.get(target.key)
			: installed.resolve(state, ctx)
	) as T
}
export function createContextHost<const TServices extends readonly ServiceInstallation[]>(
	options: ContextHostOptions<TServices>,
): ContextHost {
	const plan = createContextPlan(options.name, applyOverrides(options.services, options.overrides))
	return Object.freeze({
		name: options.name,
		createRoot: (name = 'root') => Object.preventExtensions(createRootContext(plan, name)),
		createScope: (root: RootContext, name: string) => {
			assertPlanContext(plan, root)
			return Object.preventExtensions(createScopeContext(root, name))
		},
		createChild: (parent: Context, name: string) => {
			assertPlanContext(plan, parent)
			return Object.preventExtensions(createChildContext(parent, name))
		},
	}) as ContextHost
}
/** Compile once; no factory or resource acquisition runs here. */
export function createContextPlan(
	name: string,
	source: readonly ServiceInstallation[],
): ContextPlan {
	if (typeof name !== 'string' || !name)
		throw new TypeError('[pluxel/context] Context host name is required')
	const services = new Map<ServiceKey, InstalledService>()
	let roots = 0,
		scopes = 0,
		owners = 0
	for (const value of source) {
		const item = installationRecord(value)
		if (services.has(item.key))
			throw new Error(
				`[pluxel/context] Context host ${name} installs ${describeTarget(item.definition)} more than once`,
			)
		let resolve: Resolver
		if (item.scope === 'root') {
			const index = roots++
			resolve = (state) =>
				cached(state.rootValues, index, item.definition, () => item.create!(state.root))
		} else if (item.scope === 'scope') {
			const index = scopes++
			resolve = (state) =>
				cached(state.scopeValues, index, item.definition, () => item.create!(state.scope))
		} else {
			const rootIndex = roots++,
				ownerIndex = owners++
			resolve = (state, ctx) => {
				if (state.ownerValues === EMPTY_OWNER_VALUES) state.ownerValues = []
				return cached(state.ownerValues, ownerIndex, item.definition, () => {
					const backing = cached(state.rootValues, rootIndex, item.definition, () =>
						item.createRoot!(state.root),
					)
					return item.createView!(backing, ctx)
				})
			}
		}
		services.set(
			item.key,
			Object.freeze({
				definition: item.definition,
				access: item.access,
				scope: item.scope,
				resolve,
			}),
		)
	}
	const plan = Object.freeze({}) as ContextPlan
	PLANS.set(
		plan,
		Object.freeze({
			name,
			services,
			definitions: Object.freeze([...services.values()].map(({ definition }) => definition)),
		}),
	)
	return plan
}
export function createRootContext(plan: ContextPlan, name = 'root'): RootContext {
	const compiled = compiledPlan(plan)
	const root = new ContextImpl() as unknown as RootContext
	initializeState(root, {
		plan: compiled,
		root,
		scope: root,
		name,
		rootValues: [],
		scopeValues: [],
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return root
}
export function createScopeContext(root: RootContext, name: string): Context {
	const state = readState(root)
	if (state.root !== root) throw new TypeError('[pluxel/context] A scope requires a root Context')
	const ctx = new ContextImpl() as unknown as Context
	initializeState(ctx, {
		plan: state.plan,
		root,
		scope: ctx,
		name,
		rootValues: state.rootValues,
		scopeValues: [],
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return ctx
}
export function createChildContext(parent: Context, name: string): Context {
	const state = readState(parent)
	const ctx = new ContextImpl() as unknown as Context
	initializeState(ctx, {
		plan: state.plan,
		root: state.root,
		scope: state.scope,
		parent,
		name,
		rootValues: state.rootValues,
		scopeValues: state.scopeValues,
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return ctx
}
export function createContextView(source: Context): Context {
	const state = readState(source)
	const ctx = new ContextImpl() as unknown as Context
	initializeState(ctx, {
		plan: state.plan,
		root: state.root,
		scope: state.scope,
		...(state.parent ? { parent: state.parent } : {}),
		name: state.name,
		rootValues: state.rootValues,
		scopeValues: state.scopeValues,
		ownerValues: EMPTY_OWNER_VALUES,
		...(state.serviceValues ? { serviceValues: state.serviceValues } : {}),
	})
	return ctx
}

/** Construction-only owner values; the installed service set and access remain immutable. */
export function initializeContextServiceValues(
	ctx: Context,
	values: readonly (readonly [AnyDefinition, unknown])[],
): void {
	const state = readState(ctx)
	if (state.servicesRead || state.serviceValues)
		throw new TypeError(
			'[pluxel/context] Context service values must be initialized once before service resolution',
		)
	const initialized = new Map<ServiceKey, unknown>()
	for (const [definition, value] of values) {
		const { key } = readRequired(definition)
		if (!state.plan.services.has(key))
			throw new ContextServiceMissingError(describeTarget(definition), state.plan.name)
		if (initialized.has(key))
			throw new TypeError('[pluxel/context] Context service value is initialized more than once')
		if (value === undefined)
			throw new TypeError('[pluxel/context] Context service value cannot be undefined')
		initialized.set(key, value)
	}
	state.serviceValues = initialized
}

/** Framework binding: a stable identity supplements a declaration's process-local object key. */
export function bindServiceIdentity(definition: AnyDefinition, key: string): void {
	const reference = readRequired(definition)
	if (typeof key !== 'string' || !key)
		throw new TypeError('[pluxel/context] Service identity must be a non-empty string')
	const existing =
		IDENTITIES.get(definition) ?? (typeof reference.key === 'string' ? reference.key : undefined)
	if (existing !== undefined && existing !== key) {
		if (typeof existing !== 'string')
			throw new TypeError('[pluxel/context] Service identity must be bound before installation')
		throw new TypeError('[pluxel/context] Service declaration is already bound to another identity')
	}
	IDENTITIES.set(definition, key)
	const classReference = CLASS_REFERENCES.get(definition)
	if (classReference) CLASS_REFERENCES.set(definition, Object.freeze({ ...classReference, key }))
}
export function createServiceReference<T, A extends ServiceAccess>(
	key: string,
	access: A,
): ServiceDefinition<T, A> {
	return makeReference(key, access, false) as ServiceDefinition<T, A>
}
export function createServiceRef<T, A extends ServiceAccess = ServiceAccess>(
	target: ServiceDefinition<T, A>,
	access?: A,
): ServiceRef<T, A>
export function createServiceRef<T, A extends ServiceAccess = ServiceAccess>(
	key: string,
	access: A,
): ServiceRef<T, A>
export function createServiceRef<T, A extends ServiceAccess = ServiceAccess>(
	target: string | ServiceDefinition<T, A>,
	access?: A,
): ServiceRef<T, A> {
	if (typeof target === 'string')
		return makeReference(target, access ?? 'all', true) as ServiceRef<T, A>
	const definition = readRequired(target)
	return makeReference(definition.key, access ?? definition.access, true) as ServiceRef<T, A>
}
function makeReference(key: ServiceKey, access: ServiceAccess, optional: boolean): object {
	if ((typeof key !== 'string' || !key) && !isObject(key))
		throw new TypeError('[pluxel/context] Service reference identity must be a non-empty string')
	assertServiceAccess(access)
	const value = Object.freeze({ access })
	REFERENCES.set(value, Object.freeze({ key, access, optional }))
	return value
}
export function getServiceDefinitionKey(target: AnyTarget): ServiceKey {
	return readTarget(target).key
}
export function getServiceDefinitionAccess(target: AnyTarget): ServiceAccess {
	return readTarget(target).access
}
export function isServiceRef(value: unknown): value is ServiceRef<unknown> {
	return isObject(value) && REFERENCES.get(value)?.optional === true
}
export function getInstalledServiceDefinitions(ctx: Context): readonly AnyDefinition[] {
	return readState(ctx).plan.definitions
}
export function resolveInstalledServiceDefinition(
	ctx: Context,
	key: ServiceKey,
): AnyDefinition | undefined {
	return readState(ctx).plan.services.get(key)?.definition
}
export function getInstalledServiceAccess(
	ctx: Context,
	key: ServiceKey,
): ServiceAccess | undefined {
	return readState(ctx).plan.services.get(key)?.access
}
function readRequired(target: AnyDefinition): ReferenceRecord {
	const value = readTarget(target)
	if (value.optional)
		throw new TypeError(
			'[pluxel/context] An optional ServiceRef cannot declare an installed service',
		)
	return value
}
function readTarget(target: AnyTarget): ReferenceRecord {
	if (!isObject(target))
		throw new TypeError('[pluxel/context] Invalid service declaration or reference')
	const reference = REFERENCES.get(target)
	if (reference) {
		const key =
			IDENTITIES.get(target) ??
			(isObject(reference.key) ? (IDENTITIES.get(reference.key) ?? reference.key) : reference.key)
		if (key === reference.key) return reference
		const bound = Object.freeze({ ...reference, key })
		REFERENCES.set(target, bound)
		return bound
	}
	const classReference = CLASS_REFERENCES.get(target)
	if (classReference) return classReference
	if (
		typeof target === 'function' &&
		typeof target.prototype === 'object' &&
		target.prototype !== null
	) {
		const access = (target as ServiceClass<any, ServiceAccess>).access ?? 'all'
		assertServiceAccess(access)
		const created = Object.freeze({
			key: IDENTITIES.get(target) ?? target,
			access,
			optional: false,
		})
		CLASS_REFERENCES.set(target, created)
		return created
	}
	throw new TypeError(
		'[pluxel/context] Invalid service declaration or reference; use values from the same evaluated Context kernel instance',
	)
}
function assertAccess(
	state: ContextState,
	ctx: Context,
	access: ServiceAccess,
	name: string,
	scope?: ServiceScope,
): void {
	if (
		(access === 'root' && ctx !== state.root) ||
		(access === 'owner' && ctx === state.root) ||
		(scope === 'root' && ctx !== state.root)
	)
		throw new ContextServiceAccessError(name)
}
function assertServiceAccess(value: unknown): asserts value is ServiceAccess {
	if (value !== 'all' && value !== 'root' && value !== 'owner')
		throw new TypeError('[pluxel/context] Invalid service access')
}
function installationRecord(value: ServiceInstallation): CompiledInstallation {
	const record = isObject(value) ? INSTALLATIONS.get(value) : undefined
	if (!record) throw new TypeError('[pluxel/context] Invalid service installation')
	return record
}
function compiledPlan(value: ContextPlan): CompiledPlan {
	const record = isObject(value) ? PLANS.get(value) : undefined
	if (!record) throw new TypeError('[pluxel/context] Invalid Context plan')
	return record
}
function assertPlanContext(plan: ContextPlan, ctx: Context): void {
	if (readState(ctx).plan !== compiledPlan(plan))
		throw new TypeError('[pluxel/context] Context belongs to a different host')
}
function applyOverrides(
	source: readonly ServiceInstallation[],
	overrides?: readonly ServiceInstallation[],
): readonly ServiceInstallation[] {
	if (!overrides?.length) return source
	const result = [...source]
	const positions = new Map(source.map((item, index) => [installationRecord(item).key, index]))
	const replaced = new Set<ServiceKey>()
	for (const value of overrides) {
		const item = installationRecord(value),
			index = positions.get(item.key)
		if (index === undefined)
			throw new Error(
				`[pluxel/context] Cannot override uninstalled service ${describeTarget(item.definition)}`,
			)
		if (replaced.has(item.key))
			throw new Error(
				`[pluxel/context] Service ${describeTarget(item.definition)} is overridden more than once`,
			)
		const original = installationRecord(result[index]!)
		if (original.scope !== item.scope || original.access !== item.access)
			throw new Error(
				`[pluxel/context] Override for ${describeTarget(item.definition)} must preserve scope and access`,
			)
		result[index] = value
		replaced.add(item.key)
	}
	return Object.freeze(result)
}
function cached(
	values: unknown[],
	index: number,
	definition: AnyDefinition,
	create: () => unknown,
): unknown {
	const current = values[index]
	if (current === CONSTRUCTING)
		throw new Error(`[pluxel/context] Service construction cycle at ${describeTarget(definition)}`)
	if (current !== undefined) return current
	values[index] = CONSTRUCTING
	try {
		const value = create()
		if (value === undefined)
			throw new TypeError(
				`[pluxel/context] Service ${describeTarget(definition)} returned undefined`,
			)
		values[index] = value
		return value
	} catch (error) {
		values[index] = undefined
		throw error
	}
}
function describeTarget(value: AnyTarget): string {
	const key = typeof value === 'function' ? value : readTarget(value).key
	return typeof key === 'function' ? key.name || '<anonymous service>' : String(key)
}
function isObject(value: unknown): value is object {
	return value !== null && (typeof value === 'object' || typeof value === 'function')
}
function invalidContextError(value: unknown): TypeError {
	try {
		if (isObject(value) && Object.prototype.toString.call(value) === '[object PluxelContext]')
			return new TypeError(
				'[pluxel/context] Context belongs to a different evaluated Context kernel; use values from the same evaluated kernel instance (including HMR and workspace resolution)',
			)
	} catch {}
	return new TypeError('[pluxel/context] Invalid Context implementation')
}
