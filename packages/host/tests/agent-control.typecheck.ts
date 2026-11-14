/** Compile-only consumption of the actual public SDK export. */
import { BasePlugin, PluginPart, type PluginNodeAddress } from '@pluxel/core'
import type {
	PluginDescriptor,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
	PluginTypedTarget,
	Script,
	ScriptSdk,
	ScriptPlugin,
	ScriptPluginConfig,
} from '@pluxel/host/agent'
import type { HostConfigMutation, HostPluginConfigResult } from '@pluxel/host'
import * as v from 'valibot'
import { expectTypeOf } from 'vitest'

const CounterSchema = v.object({
	step: v.optional(v.number(), 1),
	converted: v.pipe(v.string(), v.transform(Number)),
	items: v.array(v.object({ value: v.number(), label: v.string() })),
	mode: v.variant('kind', [
		v.object({ kind: v.literal('http'), url: v.string() }),
		v.object({ kind: v.literal('socket'), path: v.string() }),
	]),
})

class NominalToken {
	private readonly brand = 'token'
	read(): string {
		return this.brand
	}
}

class CounterBase extends BasePlugin {
	inherited(): 'base' {
		return 'base'
	}
}

class CounterPlugin extends CounterBase {
	readonly config = this.configs.use(CounterSchema)
	readonly count = 1
	note = ''
	private hidden = 0
	add(delta: number): number {
		this.hidden += delta
		return this.hidden
	}
	async refresh(signal: AbortSignal): Promise<number> {
		signal.throwIfAborted()
		return this.hidden
	}
	echo<T>(value: T): T {
		return value
	}
	self(): this {
		return this
	}
	convert(value: string): number
	convert(value: number): string
	convert(value: string | number): string | number {
		return typeof value === 'string' ? Number(value) : String(value)
	}
	accept(token: NominalToken): string {
		return token.read()
	}
	same(other: CounterPlugin): boolean {
		return other === this
	}
	withReceiver(this: { label: string }, suffix: string): string {
		return this.label + suffix
	}
}

type CounterInstance = CounterPlugin
type CounterInput = v.InferInput<typeof CounterSchema>
type CounterOutput = v.InferOutput<typeof CounterSchema>
declare const Counter: PluginDescriptor<CounterInput, CounterOutput, CounterInstance>
interface OtherInstance {
	title(): string
}
declare const Other: PluginDescriptor<{ title: string }, { title: string }, OtherInstance>
/** A different address can share the entire public structural declaration. */
declare const SameShape: typeof Counter
/** Instance shape is independent of the configuration contract. */
declare const SameConfig: PluginDescriptor<CounterInput, CounterOutput, OtherInstance>
declare const NoConfig: PluginDescriptor<never, never, OtherInstance>
declare const sdk: ScriptSdk
declare const address: PluginNodeAddress

expectTypeOf<PluginConfigInput<typeof Counter>>().toEqualTypeOf<CounterInput>()
expectTypeOf<PluginConfigOutput<typeof Counter>>().toEqualTypeOf<CounterOutput>()
expectTypeOf<PluginInstance<typeof Counter>>().toEqualTypeOf<CounterInstance>()
expectTypeOf<HostConfigMutation<CounterInput>['set']>().not.toBeAny()

// @ts-expect-error Annotation cannot widen the schema input accepted by a descriptor.
const widenedInput: PluginDescriptor<
	Omit<CounterInput, 'step'> & { step?: number | string },
	CounterOutput,
	CounterInstance
> = Counter
void widenedInput

const { plugin } = sdk
const counterRef = plugin(Counter)
expectTypeOf(counterRef).toEqualTypeOf<ScriptPlugin<typeof Counter>>()
expectTypeOf(counterRef.config).toEqualTypeOf<ScriptPluginConfig<CounterInput, CounterOutput>>()
expectTypeOf(counterRef.address).toEqualTypeOf<PluginNodeAddress>()
// @ts-expect-error A selector's captured address is readonly.
counterRef.address = address
const { fork: selectFork, instance: borrow, config: counterConfig } = counterRef
const selectedFork = selectFork('east')
expectTypeOf(selectedFork.config).toEqualTypeOf<ScriptPluginConfig<CounterInput, CounterOutput>>()
const { get, validate, patch, reset } = counterConfig
void patch({ set: { step: 2 } })
void validate({ set: { converted: '12' } })
void reset([['step']])
void selectedFork.config.patch({ set: { step: 2 } })
// @ts-expect-error Extracted mutation functions cannot infer a wider schema from their arguments.
void patch({ set: { converted: 12 } })
// @ts-expect-error Fork selection preserves the original schema association.
void selectedFork.config.patch({ set: { step: '2' } })
// @ts-expect-error A config annotation cannot widen the accepted input of its function properties.
const widenedConfig: ScriptPluginConfig<
	Omit<CounterInput, 'step'> & { step?: number | string },
	CounterOutput
> = counterConfig
void widenedConfig
const extractedResult = await get()
if (extractedResult.ok === true)
	expectTypeOf(extractedResult.config.converted).toEqualTypeOf<number>()
const borrowed = await borrow()
expectTypeOf(borrowed.instance).toEqualTypeOf<CounterInstance>()
const forkedBorrowed = await selectedFork.instance()
expectTypeOf(forkedBorrowed.instance).toEqualTypeOf<CounterInstance>()

void sdk.plugin(Counter).config.patch({ set: { step: 2, converted: '12' } })
const fork = { plugin: Counter, forkId: 'east' }
void sdk.plugin(fork).config.patch({ set: { step: 2 } })
void sdk.plugin({ plugin: Counter, forkId: 'east' }).config.patch({ set: { converted: '12' } })
const sameDefinitionForks =
	Math.random() > 0.5
		? ({ plugin: Counter, forkId: 'east' } as const)
		: ({ plugin: Counter, forkId: 'west' } as const)
void sdk.plugin(sameDefinitionForks).config.patch({ set: { step: 2 } })
const sameShapeTargets = Math.random() > 0.5 ? Counter : SameShape
void sdk.plugin(sameShapeTargets).config.patch({ set: { step: 2 } })
const sameConfigTargets = Math.random() > 0.5 ? Counter : SameConfig
void sdk.plugin(sameConfigTargets).config.patch({ set: { converted: '12' } })

// @ts-expect-error Incorrect fields cannot fall through to a dynamic-address overload.
void sdk.plugin(Counter).config.patch({ set: { typo: 2 } })
// @ts-expect-error Schema input differs from the transformed output.
void sdk.plugin(Counter).config.patch({ set: { converted: 12 } })
// @ts-expect-error Arrays replace complete elements.
void sdk.plugin(Counter).config.patch({ set: { items: [{ value: 2 }] } })
// @ts-expect-error Discriminated input retains its branch fields.
void sdk.plugin(Counter).config.patch({ set: { mode: { kind: 'http', path: '/tmp/socket' } } })
// @ts-expect-error A known lack of configuration rejects typed writes.
void sdk.plugin(NoConfig).config.patch({ set: {} })
// @ts-expect-error A known lack of configuration rejects typed reads.
void sdk.plugin(NoConfig).config.get()
// @ts-expect-error A no-config descriptor cannot be assigned a configured type.
const forgedConfig: typeof Other = NoConfig
void forgedConfig

const mixed = Math.random() > 0.5 ? Counter : Other
const mixedConfig = sdk.plugin(mixed).config
expectTypeOf<keyof typeof mixedConfig>().toEqualTypeOf<'get'>()
// @ts-expect-error Incompatible configuration associations require narrowing before mutation.
void sdk.plugin(mixed).config.patch({ set: { step: 2 } })
// @ts-expect-error Validation candidates must retain their target correlation.
void sdk.plugin(mixed).config.validate({ set: { title: 'updated' } })
// @ts-expect-error Reset likewise requires a consistent known configuration association.
void sdk.plugin(mixed).config.reset([['step']])
const mixedForks =
	Math.random() > 0.5 ? { plugin: Counter, forkId: 'east' } : { plugin: Other, forkId: 'west' }
// @ts-expect-error Fork targets with incompatible configuration associations also require narrowing.
void sdk.plugin(mixedForks).config.patch({ set: { step: 2 } })
const maybeConfigured = Math.random() > 0.5 ? Counter : NoConfig
// @ts-expect-error Every possible typed configuration target must declare a schema.
void sdk.plugin(maybeConfigured).config.get()
// @ts-expect-error The no-config branch cannot be erased to accept a mutation.
void sdk.plugin(maybeConfigured).config.patch({ set: { step: 2 } })
const maybeConfiguredFork = { plugin: maybeConfigured, forkId: 'east' }
// @ts-expect-error A union inside a predeclared fork must retain its no-config branch.
void sdk.plugin(maybeConfiguredFork).config.get()
// @ts-expect-error Mutation cannot drop the no-config branch nested in a fork.
void sdk.plugin(maybeConfiguredFork).config.patch({ set: { step: 2 } })
void sdk.plugin(address).config.patch({ set: { step: 'external candidate' } })

const tasks = [
	{ kind: 'counter', target: Counter },
	{ kind: 'other', target: Other },
] as const
for (const task of tasks) {
	if (task.kind === 'counter') void sdk.plugin(task.target).config.patch({ set: { step: 2 } })
	else void sdk.plugin(task.target).config.patch({ set: { title: 'updated' } })
}

const result = await sdk.plugin(Counter).config.get()
if (result.ok === true) {
	expectTypeOf(result.config.converted).toEqualTypeOf<number>()
	expectTypeOf(result.config.step).toEqualTypeOf<number>()
	// @ts-expect-error Validated output is readonly.
	result.config.step = 3
	// @ts-expect-error Nested normalized output is readonly too.
	result.config.items[0].value = 3
	// @ts-expect-error Raw observation remains unknown after successful validation.
	const raw: number = result.managedInput!.step
	void raw
} else if (result.code === 'validation_failed') {
	// @ts-expect-error A validation failure does not expose validated output.
	void result.config
	void result.errors
}
const unionResult = await sdk.plugin(mixed).config.get()
if (unionResult.ok === true) {
	// @ts-expect-error A successful union read still requires narrowing its output.
	void unionResult.config.step
}
expectTypeOf(result).toEqualTypeOf<
	HostPluginConfigResult<import('@pluxel/host').PluginApplyReportSnapshot, CounterOutput>
>()

const { instance: counter } = await sdk.plugin(Counter).instance()
expectTypeOf(counter.add(2)).toEqualTypeOf<number>()
expectTypeOf(counter.refresh(new AbortController().signal)).toEqualTypeOf<Promise<number>>()
expectTypeOf(counter.echo({ x: 1 })).toEqualTypeOf<{ x: number }>()
expectTypeOf(counter.convert('12')).toEqualTypeOf<number>()
expectTypeOf(counter.convert(12)).toEqualTypeOf<string>()
expectTypeOf(counter.inherited()).toEqualTypeOf<'base'>()
expectTypeOf(counter.same(counter)).toEqualTypeOf<boolean>()
const self: CounterInstance = counter.self()
void self
expectTypeOf(counter.self()).toEqualTypeOf<CounterPlugin>()
expectTypeOf(counter.withReceiver.call({ label: 'external' }, '!')).toEqualTypeOf<string>()
// @ts-expect-error Explicit receiver requirements remain part of the canonical signature.
counter.withReceiver('!')
counter.note = 'allowed'
// @ts-expect-error The original readonly property remains readonly.
counter.count = 3
// @ts-expect-error Original method argument types are preserved.
counter.add('2')
// @ts-expect-error Canonical type imports retain private nominal identities in signatures.
counter.accept({ read: () => 'structural imitation' })
counter.accept(new NominalToken())
expectTypeOf(counter.ctx).toEqualTypeOf<CounterPlugin['ctx']>()
// @ts-expect-error Addresses carry no concrete instance type.
void sdk.plugin(address).instance()
const unknownInstance = await sdk.plugin(mixed).instance()
// @ts-expect-error A union instance requires narrowing before a variant member.
unknownInstance.instance.add(2)
const sameConfigInstances = await sdk.plugin(sameConfigTargets).instance()
// @ts-expect-error Equal config contracts do not erase distinct instance surfaces.
sameConfigInstances.instance.add(2)
const erasedTarget: PluginTypedTarget = Counter
const erasedInstance = await sdk.plugin(erasedTarget).instance()
expectTypeOf(erasedInstance.instance).toEqualTypeOf<object>()
// @ts-expect-error Erasing the descriptor association must not invent a validated output type.
void sdk.plugin(erasedTarget).config.get()
// @ts-expect-error Erased descriptors have no statically available config surface.
void sdk.plugin(erasedTarget).config
// @ts-expect-error Known no-config descriptors have no config property.
void sdk.plugin(NoConfig).config
const { instance: other } = await sdk.plugin(NoConfig).instance()
expectTypeOf(other.title()).toEqualTypeOf<string>()

interface ThenInstance {
	then(resolve: (value: string) => void): void
	readonly marker: 'thenable'
}
declare const ThenPlugin: PluginDescriptor<never, never, ThenInstance>
const { instance: thenPlugin } = await sdk.plugin(ThenPlugin).instance()
expectTypeOf(thenPlugin.marker).toEqualTypeOf<'thenable'>()

const OptionalSchema = v.optional(v.object({ retries: v.optional(v.number(), 3) }), {})
declare const OptionalConfig: PluginDescriptor<
	v.InferInput<typeof OptionalSchema>,
	v.InferOutput<typeof OptionalSchema>,
	OtherInstance
>
void sdk.plugin(OptionalConfig).config.patch({ set: { retries: 2 } })
// @ts-expect-error Host mutation roots remain objects even when the schema input is optional.
void sdk.plugin(OptionalConfig).config.patch({ set: 'not an object' })
// @ts-expect-error Optional schema roots preserve known field input types.
void sdk.plugin(OptionalConfig).config.patch({ set: { retries: '2' } })

const UnknownInputSchema = v.pipe(
	v.unknown(),
	v.transform(() => ({ retries: 3 })),
)
declare const UnknownInput: PluginDescriptor<
	v.InferInput<typeof UnknownInputSchema>,
	v.InferOutput<typeof UnknownInputSchema>,
	OtherInstance
>
void sdk.plugin(UnknownInput).config.patch({ set: { arbitrary: 'schema accepts unknown input' } })
// @ts-expect-error A schema accepting unknown input does not allow scalar Host mutation roots.
void sdk.plugin(UnknownInput).config.patch({ set: 3 })

class ConfiguredPart extends PluginPart<PartOwner> {
	readonly config = this.configs.use(v.object({ retries: v.optional(v.number(), 3) }))
}
class PartOwner extends BasePlugin {
	readonly part = this.parts.use(ConfiguredPart)
}
declare const Owner: PluginDescriptor<never, never, PartOwner>
const { instance: owner } = await sdk.plugin(Owner).instance()
expectTypeOf(owner.part.config.retries).toEqualTypeOf<number>()
// @ts-expect-error Part-owned schema is not the owner Plugin's configuration declaration.
void sdk.plugin(Owner).config.patch({ set: { retries: 3 } })

const cursor = await sdk.logs.mark()
void sdk.logs.read(cursor, { filter: { plugin: fork } })
void sdk.logs.read(cursor, { filter: { plugin: Counter } })
void sdk.logs.read(cursor, { filter: { plugin: address } })
// @ts-expect-error The existing finite log wait deadline stays required.
void sdk.logs.wait(cursor, { filter: { plugin: Counter } })

export default (async (api, run) => {
	run.signal.throwIfAborted()
	const current = await api.plugin(Counter).config.get()
	if (current.ok === false) return current
	const changed = await api
		.plugin(Counter)
		.config.patch({ set: { step: 2 } }, { expectedManagedRevision: current.managedRevision })
	if (changed.ok === false || changed.application !== 'applied') return changed
	const { instance } = await api.plugin(Counter).instance()
	return { count: instance.add(2), changed }
}) satisfies Script
