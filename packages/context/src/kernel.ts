const CONTEXT_CAPABILITY_TYPE: unique symbol = Symbol('pluxel.context.capability')
const CONTEXT_HOST_TYPE: unique symbol = Symbol('pluxel.context.host')
const CONTEXT_PLAN_TYPE: unique symbol = Symbol('pluxel.context.plan')
const CONTEXT_INSTALLATION_TYPE: unique symbol = Symbol('pluxel.context.installation')
const CONTEXT_TYPE: unique symbol = Symbol('pluxel.context.type')
const ROOT_CONTEXT_TYPE: unique symbol = Symbol('pluxel.context.root-type')
const CONSTRUCTING = Symbol('pluxel.context.constructing')
const EMPTY_OWNER_VALUES: unknown[] = Object.freeze([]) as unknown as unknown[]

type CapabilityScope = 'root' | 'scope' | 'owner-view'

/** An opaque, identity-based key for one Context capability. */
export type ContextCapability<T> = Readonly<{
	readonly [CONTEXT_CAPABILITY_TYPE]: (value: T) => T
	readonly description: string
}>

type AnyCapability = ContextCapability<any>

type RootCapabilityOptions<T> = Readonly<{
	property?: PropertyKey
	create(ctx: RootContext): T
}>

type ScopeCapabilityOptions<T> = Readonly<{
	property?: PropertyKey
	create(ctx: Context): T
}>

type OwnerViewCapabilityOptions<TRoot, TView> = Readonly<{
	property?: PropertyKey
	createRoot(root: RootContext): TRoot
	createView(rootValue: TRoot, owner: Context): TView
}>

/**
 * Opaque, immutable input to a Context host. Installations can only be produced by the scoped
 * installation helpers; their runtime representation is deliberately not an extension contract.
 */
export interface ContextCapabilityInstallation<
	TValue = any,
	TProperty extends PropertyKey | undefined = any,
	TScope extends CapabilityScope = CapabilityScope,
> {
	readonly [CONTEXT_INSTALLATION_TYPE]: Readonly<{
		value: TValue
		property: TProperty
		scope: TScope
	}>
}

export type RootCapabilityInstallation<
	TValue = any,
	TProperty extends PropertyKey | undefined = undefined,
> = ContextCapabilityInstallation<TValue, TProperty, 'root'>

export type ScopeCapabilityInstallation<
	TValue = any,
	TProperty extends PropertyKey | undefined = undefined,
> = ContextCapabilityInstallation<TValue, TProperty, 'scope'>

export interface OwnerViewCapabilityInstallation<
	TRoot = any,
	TView = any,
	TProperty extends PropertyKey | undefined = undefined,
> {
	readonly [CONTEXT_INSTALLATION_TYPE]: Readonly<{
		value: TView
		rootValue: TRoot
		property: TProperty
		scope: 'owner-view'
	}>
}

type InstallationMetadata<TInstallation> =
	TInstallation extends Readonly<{
		readonly [CONTEXT_INSTALLATION_TYPE]: infer TMetadata
	}>
		? TMetadata
		: never

type AnyInstallationProjection<TInstallation> = TInstallation extends unknown
	? InstallationMetadata<TInstallation> extends Readonly<{
			value: infer TValue
			property: infer TProperty
		}>
		? TProperty extends PropertyKey
			? { readonly [TKey in TProperty]: TValue }
			: never
		: never
	: never

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
	value: infer TIntersection,
) => void
	? TIntersection
	: never

type ProjectionIntersection<T> = [T] extends [never] ? unknown : UnionToIntersection<T>

type NonRootInstallationProjection<TInstallation> = TInstallation extends unknown
	? InstallationMetadata<TInstallation> extends Readonly<{ scope: infer TScope }>
		? TScope extends 'scope' | 'owner-view'
			? AnyInstallationProjection<TInstallation>
			: never
		: never
	: never

/** Properties available from every Context in a host. */
export type ContextProjection<TInstallations extends readonly ContextCapabilityInstallation[]> =
	ProjectionIntersection<NonRootInstallationProjection<TInstallations[number]>>

/** Properties available only from the root Context, plus the normal Context projection. */
export type RootContextProjection<TInstallations extends readonly ContextCapabilityInstallation[]> =
	ProjectionIntersection<AnyInstallationProjection<TInstallations[number]>>

/** Plan-neutral Context shared by one root host. */
export interface Context<TRoot extends RootContext<any> = RootContext> {
	readonly [CONTEXT_TYPE]: true
	readonly root: TRoot
	readonly parent?: Context<TRoot>
	readonly name: string
	readonly [Symbol.toStringTag]: 'PluxelContext'
}

/** The root Context of one host. */
export interface RootContext<
	TRoot extends RootContext<any> = RootContext<any>,
> extends Context<TRoot> {
	readonly [ROOT_CONTEXT_TYPE]: true
}

/** An immutable owner of one compiled Context shape. */
export interface ContextHost<
	TContext extends Context<any> = Context,
	TRoot extends RootContext<any> = RootContext,
> {
	readonly [CONTEXT_HOST_TYPE]: Readonly<{ context: TContext; root: TRoot }>
	readonly name: string
	createRoot(name?: string): TRoot
	/** Create an independent capability scope whose values are shared only with its children. */
	createScope(root: TRoot, name: string): TContext
	/** Create a child owner that shares its parent's scope values and gets fresh owner views. */
	createChild(parent: TContext, name: string): TContext
}

export type ContextOf<THost extends ContextHost<any, any>> =
	THost extends ContextHost<infer TContext, any> ? TContext : never

export type RootContextOf<THost extends ContextHost<any, any>> =
	THost extends ContextHost<any, infer TRoot> ? TRoot : never

export type ContextHostOptions<
	TCapabilities extends readonly ContextCapabilityInstallation[] =
		readonly ContextCapabilityInstallation[],
> = Readonly<{
	name: string
	capabilities: TCapabilities
	/**
	 * Explicit pre-root replacements. Every item must match one base capability and preserve its
	 * scope and projected property.
	 */
	overrides?: readonly TCapabilities[number][]
}>

type ProjectedRoot<TCapabilities extends readonly ContextCapabilityInstallation[]> = RootContext<
	ProjectedRoot<TCapabilities>
> &
	RootContextProjection<TCapabilities>
type ProjectedContext<TCapabilities extends readonly ContextCapabilityInstallation[]> = Context<
	ProjectedRoot<TCapabilities>
> &
	ContextProjection<TCapabilities> &
	Readonly<{ parent?: ProjectedContext<TCapabilities> }>

type CompiledInstallation = Readonly<{
	capability: AnyCapability
	scope: CapabilityScope
	property?: PropertyKey
	create?: (ctx: any) => unknown
	createRoot?: (root: RootContext) => unknown
	createView?: (rootValue: unknown, owner: Context) => unknown
}>

type ContextResolver = (ctx: Context) => unknown
type ContextGetter = (this: Context) => unknown

/** @internal Opaque compiled plan. Its representation is not an extension contract. */
export type ContextPlan = Readonly<{
	readonly [CONTEXT_PLAN_TYPE]: true
}>

type CompiledContextPlan = Readonly<{
	name: string
	ContextConstructor: new () => ContextImpl
	RootContextConstructor: new () => ContextImpl
	resolverByCapability: ReadonlyMap<AnyCapability, ContextResolver>
}>

type ContextState = {
	readonly plan: CompiledContextPlan
	readonly root: RootContext
	readonly scope: Context
	readonly parent?: Context
	readonly name: string
	readonly rootValues: unknown[]
	readonly scopeValues: unknown[]
	ownerValues: unknown[]
}

const CAPABILITIES = new WeakSet<object>()
const INSTALLATION_RECORDS = new WeakMap<object, CompiledInstallation>()
const PLAN_RECORDS = new WeakMap<object, CompiledContextPlan>()

let initializeContextState!: (ctx: Context, state: ContextState) => void
let readContextState!: (ctx: Context) => ContextState
let createRootProjectedGetter!: (
	index: number,
	capability: AnyCapability,
	create: (ctx: RootContext) => unknown,
) => ContextGetter
let createScopeProjectedGetter!: (
	index: number,
	capability: AnyCapability,
	create: (ctx: Context) => unknown,
) => ContextGetter
let createOwnerProjectedGetter!: (
	viewIndex: number,
	rootIndex: number,
	capability: AnyCapability,
	createRoot: (root: RootContext) => unknown,
	createView: (rootValue: unknown, owner: Context) => unknown,
) => ContextGetter
let createRootDirectResolver!: (
	index: number,
	capability: AnyCapability,
	create: (ctx: RootContext) => unknown,
) => ContextResolver
let createScopeDirectResolver!: (
	index: number,
	capability: AnyCapability,
	create: (ctx: Context) => unknown,
) => ContextResolver
let createOwnerDirectResolver!: (
	viewIndex: number,
	rootIndex: number,
	capability: AnyCapability,
	createRoot: (root: RootContext) => unknown,
	createView: (rootValue: unknown, owner: Context) => unknown,
) => ContextResolver

// Deliberately does not implement Context: consumers may extend the public interface while this
// plan-neutral implementation only owns the structural fields.
class ContextImpl {
	#state?: ContextState

	static {
		initializeContextState = (ctx, state) => {
			if (!isObject(ctx)) throw invalidContextError(ctx)
			const implementation = ctx as unknown as ContextImpl
			if (!(#state in implementation)) throw invalidContextError(ctx)
			if (implementation.#state) {
				throw new TypeError('[pluxel/context] Context is already initialized')
			}
			implementation.#state = state
		}
		readContextState = (ctx) => {
			if (!isObject(ctx)) throw invalidContextError(ctx)
			const implementation = ctx as unknown as ContextImpl
			if (#state in implementation) {
				const state = implementation.#state
				if (state) return state
			}
			throw invalidContextError(ctx)
		}
		// Projected getters only exist on private frozen prototypes compiled by this kernel. Compile
		// them here so their hot path reads #state directly; explicit resolve retains boundary checks.
		createRootProjectedGetter = (index, capability, create) =>
			function (this: Context) {
				const implementation = this as unknown as ContextImpl
				const state = implementation.#state!
				const values = state.rootValues
				const current = values[index]
				if (current === CONSTRUCTING) throw constructionCycleError(capability)
				if (current !== undefined) return current
				return constructCached(values, index, capability, create, state.root)
			}
		createScopeProjectedGetter = (index, capability, create) =>
			function (this: Context) {
				const implementation = this as unknown as ContextImpl
				const state = implementation.#state!
				const values = state.scopeValues
				const current = values[index]
				if (current === CONSTRUCTING) throw constructionCycleError(capability)
				if (current !== undefined) return current
				return constructCached(values, index, capability, create, state.scope)
			}
		createOwnerProjectedGetter = (viewIndex, rootIndex, capability, createRoot, createView) =>
			function (this: Context) {
				const implementation = this as unknown as ContextImpl
				const state = implementation.#state!
				const current = state.ownerValues[viewIndex]
				if (current === CONSTRUCTING) throw constructionCycleError(capability)
				if (current !== undefined) return current
				return resolveOwnerViewMiss(
					state,
					this,
					viewIndex,
					rootIndex,
					capability,
					createRoot,
					createView,
				)
			}
		// Explicit resolution validates the receiver and selects this plan before invoking its private
		// resolver. Read #state directly here so the hot resolver does not repeat boundary validation.
		createRootDirectResolver = (index, capability, create) => (ctx) => {
			const implementation = ctx as unknown as ContextImpl
			const state = implementation.#state!
			const values = state.rootValues
			const current = values[index]
			if (current === CONSTRUCTING) throw constructionCycleError(capability)
			if (current !== undefined) return current
			return constructCached(values, index, capability, create, state.root)
		}
		createScopeDirectResolver = (index, capability, create) => (ctx) => {
			const implementation = ctx as unknown as ContextImpl
			const state = implementation.#state!
			const values = state.scopeValues
			const current = values[index]
			if (current === CONSTRUCTING) throw constructionCycleError(capability)
			if (current !== undefined) return current
			return constructCached(values, index, capability, create, state.scope)
		}
		createOwnerDirectResolver =
			(viewIndex, rootIndex, capability, createRoot, createView) => (ctx) => {
				const implementation = ctx as unknown as ContextImpl
				const state = implementation.#state!
				const current = state.ownerValues[viewIndex]
				if (current === CONSTRUCTING) throw constructionCycleError(capability)
				if (current !== undefined) return current
				return resolveOwnerViewMiss(
					state,
					ctx,
					viewIndex,
					rootIndex,
					capability,
					createRoot,
					createView,
				)
			}
	}

	get [Symbol.toStringTag](): 'PluxelContext' {
		return 'PluxelContext'
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
}

hidePrototypeConstructor(ContextImpl.prototype)
Object.freeze(ContextImpl.prototype)

export function defineContextCapability<T>(description: string): ContextCapability<T> {
	if (typeof description !== 'string' || description.length === 0) {
		throw new TypeError('[pluxel/context] Context capability description is required')
	}
	const capability = Object.freeze({ description }) as ContextCapability<T>
	CAPABILITIES.add(capability)
	return capability
}

export function installRootCapability<T, const TProperty extends PropertyKey>(
	capability: ContextCapability<T>,
	options: RootCapabilityOptions<T> & Readonly<{ property: TProperty }>,
): RootCapabilityInstallation<T, TProperty>
export function installRootCapability<T>(
	capability: ContextCapability<T>,
	options: RootCapabilityOptions<T>,
): RootCapabilityInstallation<T, undefined>
export function installRootCapability<T>(
	capability: ContextCapability<T>,
	options: RootCapabilityOptions<T>,
): RootCapabilityInstallation<T, PropertyKey | undefined> {
	return freezeRootInstallation(capability, options)
}

export function installScopeCapability<T, const TProperty extends PropertyKey>(
	capability: ContextCapability<T>,
	options: ScopeCapabilityOptions<T> & Readonly<{ property: TProperty }>,
): ScopeCapabilityInstallation<T, TProperty>
export function installScopeCapability<T>(
	capability: ContextCapability<T>,
	options: ScopeCapabilityOptions<T>,
): ScopeCapabilityInstallation<T, undefined>
export function installScopeCapability<T>(
	capability: ContextCapability<T>,
	options: ScopeCapabilityOptions<T>,
): ScopeCapabilityInstallation<T, PropertyKey | undefined> {
	assertCapability(capability)
	assertCapabilityFactory(capability, options?.create, 'create')
	return createInstallationToken<ScopeCapabilityInstallation<T, PropertyKey | undefined>>({
		capability,
		scope: 'scope' as const,
		...(options.property === undefined ? {} : { property: options.property }),
		create: options.create,
	})
}

export function installOwnerViewCapability<TRoot, TView, const TProperty extends PropertyKey>(
	capability: ContextCapability<TView>,
	options: OwnerViewCapabilityOptions<TRoot, TView> & Readonly<{ property: TProperty }>,
): OwnerViewCapabilityInstallation<TRoot, TView, TProperty>
export function installOwnerViewCapability<TRoot, TView>(
	capability: ContextCapability<TView>,
	options: OwnerViewCapabilityOptions<TRoot, TView>,
): OwnerViewCapabilityInstallation<TRoot, TView, undefined>
export function installOwnerViewCapability<TRoot, TView>(
	capability: ContextCapability<TView>,
	options: OwnerViewCapabilityOptions<TRoot, TView>,
): OwnerViewCapabilityInstallation<TRoot, TView, PropertyKey | undefined> {
	assertCapability(capability)
	assertCapabilityFactory(capability, options?.createRoot, 'createRoot')
	assertCapabilityFactory(capability, options?.createView, 'createView')
	return createInstallationToken<
		OwnerViewCapabilityInstallation<TRoot, TView, PropertyKey | undefined>
	>({
		capability,
		scope: 'owner-view' as const,
		...(options.property === undefined ? {} : { property: options.property }),
		createRoot: options.createRoot,
		createView: options.createView,
	})
}

export function createContextHost<
	const TCapabilities extends readonly ContextCapabilityInstallation[],
>(
	options: ContextHostOptions<TCapabilities>,
): ContextHost<ProjectedContext<TCapabilities>, ProjectedRoot<TCapabilities>> {
	const plan = createContextPlan(
		options.name,
		applyOverrides(options.capabilities, options.overrides),
	)
	type TContext = ProjectedContext<TCapabilities>
	type TRoot = ProjectedRoot<TCapabilities>
	const host: ContextHost<TContext, TRoot> = {
		name: options.name,
		createRoot: (name = 'root') => Object.preventExtensions(createRootContext(plan, name)) as TRoot,
		createScope: (root, name) => {
			assertPlanContext(plan, root)
			return Object.preventExtensions(createScopeContext(root, name)) as TContext
		},
		createChild: (parent, name) => {
			assertPlanContext(plan, parent)
			return Object.preventExtensions(createChildContext(parent, name)) as TContext
		},
	} as ContextHost<TContext, TRoot>
	return Object.freeze(host)
}

export function resolveContextCapability<T>(ctx: Context, capability: ContextCapability<T>): T {
	const state = stateOf(ctx)
	const resolver = state.plan.resolverByCapability.get(capability as AnyCapability)
	if (resolver === undefined) {
		assertCapability(capability)
		throw new Error(
			`[pluxel/context] Context host ${state.plan.name} does not install ${capability.description}`,
		)
	}
	return resolver(ctx) as T
}

/** @internal Compile an immutable installation set into slot resolvers and a private prototype. */
export function createContextPlan(
	name: string,
	installations: readonly ContextCapabilityInstallation[],
): ContextPlan {
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError('[pluxel/context] Context host name is required')
	}
	const resolverByCapability = new Map<AnyCapability, ContextResolver>()
	const properties = new Set<PropertyKey>()
	let rootValueCount = 0
	let scopeValueCount = 0
	let ownerValueCount = 0
	const ContextConstructor = class extends ContextImpl {}
	const RootContextConstructor = class extends ContextConstructor {}
	const contextPrototype = ContextConstructor.prototype
	const rootPrototype = RootContextConstructor.prototype

	for (const source of installations) {
		const sourceRecord = installationRecord(source, name)
		const capability = sourceRecord.capability
		if (resolverByCapability.has(capability)) {
			throw new Error(
				`[pluxel/context] Context host ${name} installs ${capability.description} more than once`,
			)
		}
		const installation = sourceRecord
		let valueIndex: number
		let rootIndex: number | undefined
		if (installation.scope === 'root') {
			valueIndex = rootValueCount++
		} else if (installation.scope === 'scope') {
			valueIndex = scopeValueCount++
		} else {
			valueIndex = ownerValueCount++
			rootIndex = rootValueCount++
		}
		resolverByCapability.set(capability, compileResolver(installation, valueIndex, rootIndex))
		if (installation.property === undefined) continue
		if (properties.has(installation.property) || installation.property in ContextImpl.prototype) {
			throw new Error(
				`[pluxel/context] Context host ${name} has a duplicate property ${String(installation.property)}`,
			)
		}
		properties.add(installation.property)
		Object.defineProperty(
			installation.scope === 'root' ? rootPrototype : contextPrototype,
			installation.property,
			{
				configurable: false,
				enumerable: false,
				get: compileProjectedGetter(installation, valueIndex, rootIndex),
			},
		)
	}

	hidePrototypeConstructor(contextPrototype)
	hidePrototypeConstructor(rootPrototype)
	Object.freeze(contextPrototype)
	Object.freeze(rootPrototype)
	Object.freeze(ContextConstructor)
	Object.freeze(RootContextConstructor)
	const compiledPlanRecord = Object.freeze({
		name,
		ContextConstructor,
		RootContextConstructor,
		resolverByCapability,
	})
	const plan = Object.freeze({}) as ContextPlan
	PLAN_RECORDS.set(plan, compiledPlanRecord)
	return plan
}

/** @internal */
export function createRootContext(plan: ContextPlan, name = 'root'): RootContext {
	const compiled = compiledPlan(plan)
	const values: unknown[] = []
	const root = allocateRootContext(compiled)
	installState(root, {
		plan: compiled,
		root,
		scope: root,
		name,
		rootValues: values,
		scopeValues: [],
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return root
}

/** @internal */
export function createScopeContext(root: RootContext, name: string): Context {
	const rootState = stateOf(root)
	if (rootState.root !== root)
		throw new TypeError('[pluxel/context] A scope requires a root Context')
	const ctx = allocateContext(rootState.plan)
	installState(ctx, {
		plan: rootState.plan,
		root,
		scope: ctx,
		name,
		rootValues: rootState.rootValues,
		scopeValues: [],
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return ctx
}

/** @internal */
export function createChildContext(parent: Context, name: string): Context {
	const parentState = stateOf(parent)
	const ctx = allocateContext(parentState.plan)
	installState(ctx, {
		plan: parentState.plan,
		root: parentState.root,
		scope: parentState.scope,
		parent,
		name,
		rootValues: parentState.rootValues,
		scopeValues: parentState.scopeValues,
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return ctx
}

/** @internal Create a fresh owner view over the source scope without adding a containment parent. */
export function createContextView(source: Context): Context {
	const sourceState = stateOf(source)
	const ctx = allocateContext(sourceState.plan)
	installState(ctx, {
		plan: sourceState.plan,
		root: sourceState.root,
		scope: sourceState.scope,
		...(sourceState.parent ? { parent: sourceState.parent } : {}),
		name: sourceState.name,
		rootValues: sourceState.rootValues,
		scopeValues: sourceState.scopeValues,
		ownerValues: EMPTY_OWNER_VALUES,
	})
	return ctx
}

function freezeRootInstallation<T>(
	capability: ContextCapability<T>,
	options: RootCapabilityOptions<T>,
): RootCapabilityInstallation<T, PropertyKey | undefined> {
	assertCapability(capability)
	assertCapabilityFactory(capability, options?.create, 'create')
	return createInstallationToken<RootCapabilityInstallation<T, PropertyKey | undefined>>({
		capability,
		scope: 'root' as const,
		...(options.property === undefined ? {} : { property: options.property }),
		create: options.create,
	})
}

function applyOverrides(
	capabilities: readonly ContextCapabilityInstallation[],
	overrides: readonly ContextCapabilityInstallation[] | undefined,
): readonly ContextCapabilityInstallation[] {
	if (!overrides?.length) return capabilities
	const result = [...capabilities]
	const indexes = new Map<AnyCapability, number>()
	for (let index = 0; index < result.length; index += 1) {
		const capability = installationRecord(result[index]!).capability
		if (!indexes.has(capability)) indexes.set(capability, index)
	}
	const replaced = new Set<AnyCapability>()
	for (const replacementToken of overrides) {
		const replacement = installationRecord(replacementToken)
		const capability = replacement.capability
		const index = indexes.get(capability)
		if (index === undefined) {
			throw new Error(
				`[pluxel/context] Cannot override uninstalled capability ${capability.description}`,
			)
		}
		if (replaced.has(capability)) {
			throw new Error(
				`[pluxel/context] Capability ${capability.description} is overridden more than once`,
			)
		}
		const original = installationRecord(result[index]!)
		if (original.scope !== replacement.scope || original.property !== replacement.property) {
			throw new Error(
				`[pluxel/context] Override for ${capability.description} must preserve scope and property`,
			)
		}
		result[index] = replacementToken
		replaced.add(capability)
	}
	return Object.freeze(result)
}

function assertCapability(capability: AnyCapability): void {
	if (!isObject(capability) || !CAPABILITIES.has(capability)) {
		if (isObject(capability) && looksLikeContextCapability(capability)) {
			throw foreignKernelError('Context capability descriptor')
		}
		throw new TypeError('[pluxel/context] Invalid Context capability descriptor')
	}
}

function assertCapabilityFactory(
	capability: AnyCapability,
	factory: unknown,
	name: 'create' | 'createRoot' | 'createView',
): void {
	if (typeof factory !== 'function') {
		throw new TypeError(
			`[pluxel/context] Context capability ${capability.description} requires a ${name} factory`,
		)
	}
}

function createInstallationToken<TInstallation extends ContextCapabilityInstallation>(
	record: object,
): TInstallation {
	const installation = Object.freeze({}) as TInstallation
	INSTALLATION_RECORDS.set(installation, Object.freeze(record) as CompiledInstallation)
	return installation
}

function installationRecord(
	installation: ContextCapabilityInstallation,
	hostName?: string,
): CompiledInstallation {
	const record = isObject(installation) ? INSTALLATION_RECORDS.get(installation) : undefined
	if (record) return record
	const host = hostName ? ` host ${hostName}` : ''
	throw new TypeError(`[pluxel/context] Context${host} received an invalid capability installation`)
}

function compiledPlan(plan: ContextPlan): CompiledContextPlan {
	const compiled = isObject(plan) ? PLAN_RECORDS.get(plan) : undefined
	if (compiled) return compiled
	throw new TypeError('[pluxel/context] Invalid Context plan')
}

function assertPlanContext(plan: ContextPlan, ctx: Context): void {
	if (stateOf(ctx).plan !== compiledPlan(plan)) {
		throw new TypeError('[pluxel/context] Context belongs to a different host')
	}
}

function allocateContext(plan: CompiledContextPlan): Context {
	return new plan.ContextConstructor() as unknown as Context
}

function allocateRootContext(plan: CompiledContextPlan): RootContext {
	return new plan.RootContextConstructor() as unknown as RootContext
}

function installState(ctx: Context, state: ContextState): void {
	initializeContextState(ctx, state)
}

function stateOf(ctx: Context): ContextState {
	return readContextState(ctx)
}

function hidePrototypeConstructor(prototype: object): void {
	Object.defineProperty(prototype, 'constructor', {
		value: undefined,
		writable: false,
		enumerable: false,
		configurable: false,
	})
}

function invalidContextError(value: unknown): TypeError {
	if (isObject(value) && hasPluxelContextTag(value)) {
		return foreignKernelError('Context')
	}
	return new TypeError('[pluxel/context] Invalid Context implementation')
}

function foreignKernelError(subject: 'Context' | 'Context capability descriptor'): TypeError {
	return new TypeError(
		[
			`[pluxel/context] ${subject} belongs to a different evaluated Context kernel.`,
			'Use Context values, capability descriptors, installations, and plans from the same evaluated kernel instance.',
			'This usually means @pluxel/context and @pluxel/core values were mixed, or one package was evaluated more than once through HMR or workspace resolution.',
		].join('\n'),
	)
}

function hasPluxelContextTag(value: object): boolean {
	try {
		return Object.prototype.toString.call(value) === '[object PluxelContext]'
	} catch {
		return false
	}
}

function looksLikeContextCapability(value: object): boolean {
	try {
		const keys = Reflect.ownKeys(value)
		if (keys.length !== 1 || keys[0] !== 'description' || !Object.isFrozen(value)) return false
		const description = Object.getOwnPropertyDescriptor(value, 'description')
		return (
			description !== undefined &&
			typeof description.value === 'string' &&
			description.value.length > 0 &&
			description.enumerable === true &&
			description.configurable === false &&
			description.writable === false
		)
	} catch {
		return false
	}
}

function isObject(value: unknown): value is object {
	return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function compileResolver(
	installation: CompiledInstallation,
	valueIndex: number,
	rootIndex: number | undefined,
): ContextResolver {
	const capability = installation.capability
	if (installation.scope === 'root') {
		return createRootDirectResolver(valueIndex, capability, installation.create!)
	}
	if (installation.scope === 'scope') {
		return createScopeDirectResolver(valueIndex, capability, installation.create!)
	}
	return createOwnerDirectResolver(
		valueIndex,
		rootIndex!,
		capability,
		installation.createRoot!,
		installation.createView!,
	)
}

function compileProjectedGetter(
	installation: CompiledInstallation,
	valueIndex: number,
	rootIndex: number | undefined,
): ContextGetter {
	const capability = installation.capability
	if (installation.scope === 'root') {
		return createRootProjectedGetter(valueIndex, capability, installation.create!)
	}
	if (installation.scope === 'scope') {
		return createScopeProjectedGetter(valueIndex, capability, installation.create!)
	}
	return createOwnerProjectedGetter(
		valueIndex,
		rootIndex!,
		capability,
		installation.createRoot!,
		installation.createView!,
	)
}

function readCached(current: unknown, capability: AnyCapability): unknown {
	if (current === CONSTRUCTING) throw constructionCycleError(capability)
	return current
}

function constructionCycleError(capability: AnyCapability): Error {
	return new Error(
		`[pluxel/context] Context capability construction cycle at ${capability.description}`,
	)
}

function resolveOwnerViewMiss(
	state: ContextState,
	owner: Context,
	viewIndex: number,
	rootIndex: number,
	capability: AnyCapability,
	createRoot: (root: RootContext) => unknown,
	createView: (rootValue: unknown, owner: Context) => unknown,
): unknown {
	let ownerValues = state.ownerValues
	if (ownerValues === EMPTY_OWNER_VALUES) state.ownerValues = ownerValues = []
	const rootValues = state.rootValues
	const rootCurrent = rootValues[rootIndex]
	const rootValue =
		rootCurrent === undefined
			? constructCached(rootValues, rootIndex, capability, createRoot, state.root)
			: readCached(rootCurrent, capability)
	return constructOwnerView(ownerValues, viewIndex, capability, createView, rootValue, owner)
}

function constructCached<TContext extends Context>(
	values: unknown[],
	index: number,
	capability: AnyCapability,
	create: (ctx: TContext) => unknown,
	ctx: TContext,
): unknown {
	values[index] = CONSTRUCTING
	try {
		const value = create(ctx)
		if (value === undefined) {
			throw new TypeError(
				`[pluxel/context] Context capability ${capability.description} returned undefined`,
			)
		}
		values[index] = value
		return value
	} catch (error) {
		values[index] = undefined
		throw error
	}
}

function constructOwnerView(
	values: unknown[],
	index: number,
	capability: AnyCapability,
	create: (rootValue: unknown, owner: Context) => unknown,
	rootValue: unknown,
	owner: Context,
): unknown {
	values[index] = CONSTRUCTING
	try {
		const value = create(rootValue, owner)
		if (value === undefined) {
			throw new TypeError(
				`[pluxel/context] Context capability ${capability.description} returned undefined`,
			)
		}
		values[index] = value
		return value
	} catch (error) {
		values[index] = undefined
		throw error
	}
}
