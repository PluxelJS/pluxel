import type {
	RuntimeConsoleSinkInput,
	RuntimeCustomSinkInput,
	RuntimeFileSinkInput,
	RuntimeLoggingInput,
	RuntimeLoggingRootInput,
	RuntimeLoggingRouteBinding,
	RuntimeStoreSinkInput,
} from './logging'
import type { PluginLogPolicyOverride, PluginLogPolicySnapshot } from './policy'
type ClosedConfigFields<Config extends object> = {
	readonly [Key in keyof Config]-?: true
}

/** @internal Defines an exhaustive runtime field set for one closed configuration object. */
export function closedConfigFields<Config extends object>(
	fields: ClosedConfigFields<Config>,
): ReadonlySet<string> {
	return new Set(Object.keys(fields))
}

/** @internal Rejects fields outside an exhaustive closed configuration contract. */
export function assertKnownConfigFields(
	config: object,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	const unknown = Object.getOwnPropertyNames(config).filter((field) => !allowed.has(field))
	if (unknown.length === 0) return
	throw new TypeError(
		`${label} includes unsupported ${unknown.map((field) => `"${field}"`).join(', ')}`,
	)
}

function assertOptionalClosedConfig(
	input: unknown,
	fields: ReadonlySet<string>,
	label: string,
): void {
	if (input === undefined) return
	const config = configObject(input, label)
	assertKnownConfigFields(config, fields, label)
}

function configObject(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`${label} must be an object`)
	}
	return input as Record<string, unknown>
}

type RuntimeStoreCaps = NonNullable<RuntimeStoreSinkInput['caps']>
type RuntimeLoggingRoutes = RuntimeLoggingInput['routes']
const LOGGING_FIELDS = closedConfigFields<RuntimeLoggingInput>({
	root: true,
	sinks: true,
	routes: true,
})
const LOGGING_ROOT_FIELDS = closedConfigFields<RuntimeLoggingRootInput>({
	profile: true,
	initialPluginPolicy: true,
	debugTopics: true,
	policyLoadFailure: true,
})
const LOGGING_POLICY_FIELDS = closedConfigFields<PluginLogPolicySnapshot>({
	version: true,
	defaultLevel: true,
	overrides: true,
})
const LOGGING_POLICY_OVERRIDE_FIELDS = closedConfigFields<PluginLogPolicyOverride>({
	owner: true,
	level: true,
})
const CONSOLE_SINK_FIELDS = closedConfigFields<RuntimeConsoleSinkInput>({
	kind: true,
	format: true,
	caller: true,
	timezone: true,
})
const FILE_SINK_FIELDS = closedConfigFields<RuntimeFileSinkInput>({
	kind: true,
	path: true,
	format: true,
	caller: true,
	timezone: true,
})
const STORE_SINK_FIELDS = closedConfigFields<RuntimeStoreSinkInput>({
	kind: true,
	caller: true,
	streamId: true,
	minLevel: true,
	bufferSize: true,
	flushIntervalMs: true,
	windowLines: true,
	hiddenKeys: true,
	redactKeys: true,
	includeRaw: true,
	caps: true,
})
const STORE_CAPS_FIELDS = closedConfigFields<RuntimeStoreCaps>({
	maxMsgChars: true,
	maxMessageParts: true,
	maxMessagePartChars: true,
	maxPropsKeys: true,
})
const CUSTOM_SINK_FIELDS = closedConfigFields<RuntimeCustomSinkInput>({
	kind: true,
	label: true,
	sink: true,
	caller: true,
})
const LOGGING_ROUTES_FIELDS = closedConfigFields<RuntimeLoggingRoutes>({
	runtime: true,
	plugins: true,
	debug: true,
	meta: true,
})
const LOGGING_ROUTE_FIELDS = closedConfigFields<RuntimeLoggingRouteBinding>({
	sink: true,
	minLevel: true,
})
/** @internal Validates the closed structural fields in a Runtime logging plan. */
export function assertRuntimeLoggingInput(
	input: unknown,
	label = '[pluxel/runtime] logging',
): void {
	const logging = configObject(input, label)
	assertKnownConfigFields(logging, LOGGING_FIELDS, label)

	const root = configObject(logging.root, `${label}.root`)
	assertKnownConfigFields(root, LOGGING_ROOT_FIELDS, `${label}.root`)
	if (root.initialPluginPolicy !== undefined) {
		assertLoggingPolicy(root.initialPluginPolicy, `${label}.root.initialPluginPolicy`)
	}

	const sinks = configObject(logging.sinks, `${label}.sinks`)
	for (const [sinkId, inputSink] of Object.entries(sinks)) {
		const sinkLabel = `${label}.sinks[${JSON.stringify(sinkId)}]`
		const sink = configObject(inputSink, sinkLabel)
		switch (sink.kind) {
			case 'console':
				assertKnownConfigFields(sink, CONSOLE_SINK_FIELDS, sinkLabel)
				break
			case 'file':
				assertKnownConfigFields(sink, FILE_SINK_FIELDS, sinkLabel)
				break
			case 'store':
				assertKnownConfigFields(sink, STORE_SINK_FIELDS, sinkLabel)
				assertOptionalClosedConfig(sink.caps, STORE_CAPS_FIELDS, `${sinkLabel}.caps`)
				break
			case 'logtape':
				assertKnownConfigFields(sink, CUSTOM_SINK_FIELDS, sinkLabel)
				break
			default:
				throw new TypeError(`${sinkLabel}.kind must identify a supported logging sink`)
		}
	}

	const routes = configObject(logging.routes, `${label}.routes`)
	assertKnownConfigFields(routes, LOGGING_ROUTES_FIELDS, `${label}.routes`)
	for (const family of ['runtime', 'plugins', 'debug', 'meta'] as const) {
		const bindings = routes[family]
		if (!Array.isArray(bindings)) {
			throw new TypeError(`${label}.routes.${family} must be an array`)
		}
		bindings.forEach((binding, index) => {
			const bindingLabel = `${label}.routes.${family}[${index}]`
			const record = configObject(binding, bindingLabel)
			assertKnownConfigFields(record, LOGGING_ROUTE_FIELDS, bindingLabel)
		})
	}
}

function assertLoggingPolicy(input: unknown, label: string): void {
	const policy = configObject(input, label)
	assertKnownConfigFields(policy, LOGGING_POLICY_FIELDS, label)
	if (!Array.isArray(policy.overrides)) {
		throw new TypeError(`${label}.overrides must be an array`)
	}
	policy.overrides.forEach((override, index) => {
		const overrideLabel = `${label}.overrides[${index}]`
		const record = configObject(override, overrideLabel)
		assertKnownConfigFields(record, LOGGING_POLICY_OVERRIDE_FIELDS, overrideLabel)
	})
}
