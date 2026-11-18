/** Compile-only consumption of the actual public SDK export. */
import { BasePlugin, PluginPart, type PluginNodeAddress, type ServiceRef } from '@pluxel/core'
import { ScriptError } from '@pluxel/agent-sdk/host'
import type { LogReadOptions } from '@pluxel/core/logging'
import type {
	PluginDescriptor,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
	PluginTypedNodeAddress,
	Script,
	ScriptSdk,
	ScriptPlugin,
	ScriptPluginConfig,
	ScriptConfigSnapshot,
	ScriptConfigError,
	ScriptInstanceError,
	ScriptOperationError,
	ScriptLogError,
} from '@pluxel/agent-sdk/host'
import type { HostConfigMutation, HostPluginConfigResultOk } from '@pluxel/host'
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

expectTypeOf<
	PluginConfigInput<ReturnType<typeof Counter.nodeAddress>>
>().toEqualTypeOf<CounterInput>()
expectTypeOf<
	PluginConfigOutput<ReturnType<typeof Counter.nodeAddress>>
>().toEqualTypeOf<CounterOutput>()
expectTypeOf<
	PluginInstance<ReturnType<typeof Counter.nodeAddress>>
>().toEqualTypeOf<CounterInstance>()
expectTypeOf<HostConfigMutation<CounterInput>['set']>().not.toBeAny()

// @ts-expect-error Annotation cannot widen the schema input accepted by a descriptor.
const widenedInput: PluginDescriptor<
	Omit<CounterInput, 'step'> & { step?: number | string },
	CounterOutput,
	CounterInstance
> = Counter
void widenedInput

const { plugin } = sdk
// @ts-expect-error Import Better Result from its own module when constructing a result.
void sdk.Result
const counterAddress = Counter.nodeAddress()
const counterRef = plugin(counterAddress)
// @ts-expect-error Selectors accept node addresses, never descriptor objects.
plugin(Counter)
// @ts-expect-error Fork selection belongs to the address provider.
void counterRef.fork
expectTypeOf(counterRef).toEqualTypeOf<ScriptPlugin<typeof counterAddress>>()
expectTypeOf(counterRef.config).toEqualTypeOf<ScriptPluginConfig<CounterInput, CounterOutput>>()
expectTypeOf(counterRef.address).toExtend<typeof counterAddress>()
expectTypeOf(counterAddress).toExtend<typeof counterRef.address>()
expectTypeOf(counterRef.address.variant).toEqualTypeOf<'default'>()
expectTypeOf(plugin(counterRef.address)).toEqualTypeOf<typeof counterRef>()
// @ts-expect-error A selector's captured address is readonly.
counterRef.address = address
const { instance: borrow, config: counterConfig } = counterRef
const selectedFork = plugin(Counter.nodeAddress('east'))
expectTypeOf(selectedFork.address.variant).toEqualTypeOf<'fork'>()
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
expectTypeOf(extractedResult.config.converted).toEqualTypeOf<number>()
const borrowed = (await borrow()).instance
expectTypeOf(borrowed).toEqualTypeOf<CounterInstance>()
expectTypeOf<Awaited<ReturnType<typeof borrow>>>().toEqualTypeOf<
	Readonly<{ instance: CounterInstance }>
>()
const forkedBorrowed = (await selectedFork.instance()).instance
expectTypeOf(forkedBorrowed).toEqualTypeOf<CounterInstance>()

void sdk.plugin(Counter.nodeAddress()).config.patch({ set: { step: 2, converted: '12' } })
const fork = sdk.plugin(Counter.nodeAddress('east'))
// @ts-expect-error Selection accepts a complete node address.
void sdk.plugin({ plugin: Counter, forkId: 'east' })
void fork.config.patch({ set: { step: 2 } })
void sdk.plugin(Counter.nodeAddress('east')).config.patch({ set: { converted: '12' } })
const sameDefinitionForks = sdk.plugin(Counter.nodeAddress(Math.random() > 0.5 ? 'east' : 'west'))
void sameDefinitionForks.config.patch({ set: { step: 2 } })
const sameShapeTargets = Math.random() > 0.5 ? Counter : SameShape
void sdk.plugin(sameShapeTargets.nodeAddress()).config.patch({ set: { step: 2 } })
const sameConfigTargets = Math.random() > 0.5 ? Counter : SameConfig
void sdk.plugin(sameConfigTargets.nodeAddress()).config.patch({ set: { converted: '12' } })

// @ts-expect-error Incorrect fields cannot fall through to a dynamic-address overload.
void sdk.plugin(Counter.nodeAddress()).config.patch({ set: { typo: 2 } })
// @ts-expect-error Schema input differs from the transformed output.
void sdk.plugin(Counter.nodeAddress()).config.patch({ set: { converted: 12 } })
// @ts-expect-error Arrays replace complete elements.
void sdk.plugin(Counter.nodeAddress()).config.patch({ set: { items: [{ value: 2 }] } })
// @ts-expect-error Discriminated input retains its branch fields.
void counterRef.config.patch({ set: { mode: { kind: 'http', path: '/tmp/socket' } } })
// @ts-expect-error A known lack of configuration rejects typed writes.
void sdk.plugin(NoConfig.nodeAddress()).config.patch({ set: {} })
// @ts-expect-error A known lack of configuration rejects typed reads.
void sdk.plugin(NoConfig.nodeAddress()).config.get()
// @ts-expect-error A no-config descriptor cannot be assigned a configured type.
const forgedConfig: typeof Other = NoConfig
void forgedConfig

const mixed = Math.random() > 0.5 ? Counter : Other
const mixedConfig = sdk.plugin(mixed.nodeAddress()).config
expectTypeOf<keyof typeof mixedConfig>().toEqualTypeOf<'get'>()
// @ts-expect-error Incompatible configuration associations require narrowing before mutation.
void sdk.plugin(mixed.nodeAddress()).config.patch({ set: { step: 2 } })
// @ts-expect-error Validation candidates must retain their target correlation.
void sdk.plugin(mixed.nodeAddress()).config.validate({ set: { title: 'updated' } })
// @ts-expect-error Reset likewise requires a consistent known configuration association.
void sdk.plugin(mixed.nodeAddress()).config.reset([['step']])
const mixedForks = sdk.plugin(mixed.nodeAddress(Math.random() > 0.5 ? 'east' : 'west'))
// @ts-expect-error Fork targets with incompatible configuration associations also require narrowing.
void mixedForks.config.patch({ set: { step: 2 } })
const maybeConfigured = Math.random() > 0.5 ? Counter : NoConfig
// @ts-expect-error Every possible typed configuration target must declare a schema.
void sdk.plugin(maybeConfigured.nodeAddress()).config.get()
// @ts-expect-error The no-config branch cannot be erased to accept a mutation.
void sdk.plugin(maybeConfigured.nodeAddress()).config.patch({ set: { step: 2 } })
const maybeConfiguredFork = sdk.plugin(maybeConfigured.nodeAddress('east'))
// @ts-expect-error A union inside a predeclared fork must retain its no-config branch.
void maybeConfiguredFork.config.get()
// @ts-expect-error Mutation cannot drop the no-config branch nested in a fork.
void maybeConfiguredFork.config.patch({ set: { step: 2 } })
void sdk.plugin(address).config.patch({ set: { step: 'external candidate' } })

const tasks = [
	{ kind: 'counter', target: Counter },
	{ kind: 'other', target: Other },
] as const
for (const task of tasks) {
	if (task.kind === 'counter')
		void sdk.plugin(task.target.nodeAddress()).config.patch({ set: { step: 2 } })
	else void sdk.plugin(task.target.nodeAddress()).config.patch({ set: { title: 'updated' } })
}

const result = await sdk.plugin(Counter.nodeAddress()).config.get()
expectTypeOf(result).toEqualTypeOf<ScriptConfigSnapshot<CounterOutput>>()
expectTypeOf<ScriptInstanceError['code']>().toEqualTypeOf<
	| 'scope_closed'
	| 'cancelled'
	| 'borrowed_generation_conflict'
	| 'control_evidence_missing'
	| 'control_format_unsupported'
	| 'control_material_unavailable'
	| 'control_contract_mismatch'
	| 'target_unavailable'
	| 'stale_target'
	| 'plugin_not_running'
>()
expectTypeOf<Extract<ScriptInstanceError, { code: 'validation_failed' }>>().toEqualTypeOf<never>()
expectTypeOf<Extract<ScriptOperationError, { code: 'persistence_failed' }>>().toEqualTypeOf<never>()
expectTypeOf(result.config.converted).toEqualTypeOf<number>()
expectTypeOf(result.config.step).toEqualTypeOf<number>()
// @ts-expect-error Validated output is readonly.
result.config.step = 3
// @ts-expect-error Nested normalized output is readonly too.
result.config.items[0].value = 3
// @ts-expect-error Raw observation remains unknown after successful validation.
const raw: number = result.managedInput!.step
void raw
declare const configFailure: ScriptConfigError
if (configFailure.code === 'validation_failed') {
	// @ts-expect-error A validation failure does not expose validated output.
	void configFailure.config
	void configFailure.errors
}
if (configFailure.code === 'persistence_failed') {
	expectTypeOf(configFailure.state).toEqualTypeOf<'unknown'>()
	// @ts-expect-error Persistence failure retains uncertainty and cannot claim a validated output.
	void configFailure.config
}
// @ts-expect-error SDK error details are readonly domain values.
configFailure.message = 'rewritten'
// @ts-expect-error Failure details have no duplicate domain discriminator.
void configFailure.ok
declare const failure: unknown
if (failure instanceof ScriptError && failure.details.code === 'persistence_failed') {
	expectTypeOf(failure.details.state).toEqualTypeOf<'unchanged' | 'unknown'>()
}
const unionResult = await sdk.plugin(mixed.nodeAddress()).config.get()
// @ts-expect-error A successful union read still requires narrowing its output.
void unionResult.config.step
expectTypeOf(result).toEqualTypeOf<
	Readonly<
		Omit<
			HostPluginConfigResultOk<import('@pluxel/host').PluginApplyReportSnapshot, CounterOutput>,
			'ok'
		>
	>
>()
// @ts-expect-error Success has no duplicate domain discriminator.
void result.ok
expectTypeOf(sdk.ctx).toEqualTypeOf<import('@pluxel/core').RootContext>()
expectTypeOf(sdk.ctx.logger).toEqualTypeOf<import('@pluxel/core').ContextLogger>()
expectTypeOf(sdk.ctx.effects).toEqualTypeOf<import('@pluxel/core').EffectsScope>()
expectTypeOf(sdk.ctx.logging).toEqualTypeOf<
	import('@pluxel/core/logging').RuntimeLogging | undefined
>()
abstract class SharedService {
	abstract value: number
}
declare const optionalService: ServiceRef<SharedService>
expectTypeOf(sdk.ctx.service(SharedService)).toEqualTypeOf<SharedService>()
expectTypeOf(sdk.ctx.service(optionalService)).toEqualTypeOf<SharedService | undefined>()
declare const untypedServiceOwner: PluginNodeAddress
const ownerContext = await sdk.plugin(untypedServiceOwner).context()
expectTypeOf(ownerContext).toEqualTypeOf<import('@pluxel/core').PluginContext>()
expectTypeOf(ownerContext.fs).toEqualTypeOf<import('@pluxel/core').PluginContext['fs']>()
expectTypeOf(ownerContext.tinybase).toEqualTypeOf<
	import('@pluxel/core').PluginContext['tinybase']
>()
// @ts-expect-error Runtime logging is owned by the root.
void ownerContext.logging
// @ts-expect-error Plugin data access requires a Plugin owner.
void sdk.ctx.fs
expectTypeOf(
	(await sdk.plugin(untypedServiceOwner).context()).service(SharedService),
).toEqualTypeOf<SharedService>()
// @ts-expect-error Only one SDK surface exists in every execution environment.
void sdk.dev

const counter = (await sdk.plugin(Counter.nodeAddress()).instance()).instance
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
const unknownInstance = (await sdk.plugin(mixed.nodeAddress()).instance()).instance
// @ts-expect-error A union instance requires narrowing before a variant member.
unknownInstance.add(2)
const sameConfigInstances = (await sdk.plugin(sameConfigTargets.nodeAddress()).instance()).instance
// @ts-expect-error Equal config contracts do not erase distinct instance surfaces.
sameConfigInstances.add(2)
const erasedTarget: PluginTypedNodeAddress = Counter.nodeAddress()
const erasedInstance = (await sdk.plugin(erasedTarget).instance()).instance
expectTypeOf(erasedInstance).toEqualTypeOf<object>()
// @ts-expect-error Erasing the descriptor association must not invent a validated output type.
void sdk.plugin(erasedTarget).config.get()
// @ts-expect-error Erased descriptors have no statically available config surface.
void sdk.plugin(erasedTarget).config
// @ts-expect-error Known no-config descriptors have no config property.
void sdk.plugin(NoConfig.nodeAddress()).config
// @ts-expect-error Reselecting a known no-config address cannot enable dynamic configuration.
void sdk.plugin(sdk.plugin(NoConfig.nodeAddress()).address).config
const other = (await sdk.plugin(NoConfig.nodeAddress()).instance()).instance
expectTypeOf(other.title()).toEqualTypeOf<string>()

class OtherSourcePlugin extends BasePlugin {
	title(): string {
		return 'other'
	}
}
const sourceChoice =
	Math.random() > 0.5 ? CounterPlugin.nodeAddress() : OtherSourcePlugin.nodeAddress()
const sourceInstance = (await sdk.plugin(sourceChoice).instance()).instance
expectTypeOf(sourceInstance).toEqualTypeOf<CounterPlugin | OtherSourcePlugin>()
expectTypeOf<PluginInstance<typeof sourceChoice>>().toEqualTypeOf<typeof sourceInstance>()
const sourceCounterAddress = CounterPlugin.nodeAddress()
expectTypeOf<PluginInstance<typeof sourceCounterAddress>>().toEqualTypeOf<CounterPlugin>()
expectTypeOf(sdk.plugin(sourceChoice).config).toEqualTypeOf<ScriptPluginConfig>()
const sourceRef = sdk.plugin(sourceCounterAddress)
expectTypeOf(sourceRef.config).toEqualTypeOf<ScriptPluginConfig>()
expectTypeOf(sdk.plugin(sourceRef.address)).toEqualTypeOf<typeof sourceRef>()
void sourceRef.config.patch({ set: { count: 3 } })
const controlOrSource = Math.random() > 0.5 ? Counter.nodeAddress() : CounterPlugin.nodeAddress()
const controlOrSourceInstance = (await sdk.plugin(controlOrSource).instance()).instance
expectTypeOf(controlOrSourceInstance).toEqualTypeOf<CounterPlugin>()
expectTypeOf<PluginInstance<typeof controlOrSource>>().toEqualTypeOf<
	typeof controlOrSourceInstance
>()
// @ts-expect-error Mixed evidence retains instance access but requires narrowing for configuration.
void sdk.plugin(controlOrSource).config
type RawOrControl = PluginNodeAddress | ReturnType<typeof Counter.nodeAddress>
declare const rawOrControl: RawOrControl
const rawOrControlRef = sdk.plugin<RawOrControl>(rawOrControl)
expectTypeOf<PluginInstance<RawOrControl>>().toBeNever()
// @ts-expect-error A union with a plain address has no common instance evidence.
void rawOrControlRef.instance()
// @ts-expect-error Plain and typed branches require narrowing or explicit identity normalization.
void rawOrControlRef.config
type RawOrSource = PluginNodeAddress | ReturnType<typeof CounterPlugin.nodeAddress>
declare const rawOrSource: RawOrSource
const rawOrSourceRef = sdk.plugin<RawOrSource>(rawOrSource)
expectTypeOf<PluginInstance<RawOrSource>>().toBeNever()
expectTypeOf<PluginInstance<PluginNodeAddress>>().toBeNever()
// @ts-expect-error Source evidence cannot make a plain address acquire instance access.
void rawOrSourceRef.instance()
expectTypeOf(rawOrSourceRef.config).toEqualTypeOf<ScriptPluginConfig>()
const erasedNode: PluginNodeAddress = CounterPlugin.nodeAddress()
expectTypeOf(sdk.plugin(erasedNode).config).toEqualTypeOf<ScriptPluginConfig>()

const mutableAddress = {
	definition: {
		entry: { kind: 'package-root' as const, packageName: '@example/worker' },
		exportName: 'Worker',
	},
	variant: 'default' as const,
}
const captured = sdk.plugin(mutableAddress)
// @ts-expect-error A captured identity is immutable even when its input is mutable.
captured.address.definition.exportName = 'Changed'
// @ts-expect-error Nested entry fields also describe the frozen snapshot.
captured.address.definition.entry.packageName = '@example/changed'
mutableAddress.definition.exportName = 'AuthorOwned'

interface ThenInstance {
	then(resolve: (value: string) => void): void
	readonly marker: 'thenable'
}
declare const ThenPlugin: PluginDescriptor<never, never, ThenInstance>
const thenPlugin = (await sdk.plugin(ThenPlugin.nodeAddress()).instance()).instance
expectTypeOf(thenPlugin.marker).toEqualTypeOf<'thenable'>()

const OptionalSchema = v.optional(v.object({ retries: v.optional(v.number(), 3) }), {})
declare const OptionalConfig: PluginDescriptor<
	v.InferInput<typeof OptionalSchema>,
	v.InferOutput<typeof OptionalSchema>,
	OtherInstance
>
void sdk.plugin(OptionalConfig.nodeAddress()).config.patch({ set: { retries: 2 } })
// @ts-expect-error Host mutation roots remain objects even when the schema input is optional.
void sdk.plugin(OptionalConfig.nodeAddress()).config.patch({ set: 'not an object' })
// @ts-expect-error Optional schema roots preserve known field input types.
void sdk.plugin(OptionalConfig.nodeAddress()).config.patch({ set: { retries: '2' } })

const UnknownInputSchema = v.pipe(
	v.unknown(),
	v.transform(() => ({ retries: 3 })),
)
declare const UnknownInput: PluginDescriptor<
	v.InferInput<typeof UnknownInputSchema>,
	v.InferOutput<typeof UnknownInputSchema>,
	OtherInstance
>
void sdk
	.plugin(UnknownInput.nodeAddress())
	.config.patch({ set: { arbitrary: 'schema accepts unknown input' } })
// @ts-expect-error A schema accepting unknown input does not allow scalar Host mutation roots.
void sdk.plugin(UnknownInput.nodeAddress()).config.patch({ set: 3 })

class ConfiguredPart extends PluginPart<PartOwner> {
	readonly config = this.configs.use(v.object({ retries: v.optional(v.number(), 3) }))
}
class PartOwner extends BasePlugin {
	readonly part = this.parts.use(ConfiguredPart)
}
declare const Owner: PluginDescriptor<never, never, PartOwner>
const owner = (await sdk.plugin(Owner.nodeAddress()).instance()).instance
expectTypeOf(owner.part.config.retries).toEqualTypeOf<number>()
// @ts-expect-error Part-owned schema is not the owner Plugin's configuration declaration.
void sdk.plugin(Owner.nodeAddress()).config.patch({ set: { retries: 3 } })

const cursor = await sdk.logs.mark()
declare const logError: ScriptLogError
expectTypeOf(logError.message).toEqualTypeOf<string>()
// @ts-expect-error Every SDK log error has a readonly diagnostic, including native cursor failures.
logError.message = 'rewritten'
// @ts-expect-error Native log error codes cannot be mutated through the public SDK type.
logError.code = 'root_mismatch'
const logResult = await sdk.logs.read(cursor)
void logResult.lines
void sdk.logs.read(cursor, { filter: { plugin: fork.address } })
void sdk.logs.read(cursor, { filter: { plugin: Counter.nodeAddress() } })
void sdk.logs.read(cursor, { filter: { plugin: address } })
const nativeLogOptions: LogReadOptions = { filter: { plugin: Counter.nodeAddress() } }
void sdk.logs.read(cursor, nativeLogOptions)
void sdk.logs.wait(cursor, { ...nativeLogOptions, timeoutMs: 100 })
expectTypeOf<Parameters<ScriptSdk['logs']['read']>[1]>().toEqualTypeOf<LogReadOptions | undefined>()
expectTypeOf<Parameters<ScriptSdk['logs']['wait']>[1]>().toEqualTypeOf<
	LogReadOptions & Readonly<{ timeoutMs: number }>
>()
// @ts-expect-error The existing finite log wait deadline stays required.
void sdk.logs.wait(cursor, { filter: { plugin: Counter.nodeAddress() } })

// @ts-expect-error Source queries use @pluxel/agent-sdk/source without a Host.
void sdk.inspect(Counter.address())

export default (async (api, run) => {
	run.signal.throwIfAborted()
	const selected = api.plugin(Counter.nodeAddress())
	const current = await selected.config.get()
	const changed = await selected.config.patch(
		{ set: { step: 2 } },
		{ expectedManagedRevision: current.managedRevision },
	)
	if (changed.application !== 'applied') return changed
	const { instance } = await selected.instance()
	return { count: instance.add(2), changed }
}) satisfies Script
