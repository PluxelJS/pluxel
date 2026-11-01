import type { RuntimeLoggingOptions } from './logging'
import { normalizePluginLogPolicySnapshot } from './policy'
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

function configObject(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`${label} must be an object`)
	}
	return input as Record<string, unknown>
}

const LOGGING_OPTIONS_FIELDS = closedConfigFields<RuntimeLoggingOptions>({
	profile: true,
	initialPluginPolicy: true,
	debugTopics: true,
	policyLoadFailure: true,
})

/** Native LogTape owns its configuration schema; Pluxel checks only its entry shape. */
export function assertRuntimeLoggingInput(input: unknown, label = '[core.logtape] config'): void {
	if (typeof input === 'function') return
	const config = configObject(input, label)
	const sinks = configObject(config.sinks, `${label}.sinks`)
	for (const [name, sink] of Object.entries(sinks)) {
		if (typeof sink !== 'function')
			throw new TypeError(`${label}.sinks[${JSON.stringify(name)}] must be a native LogTape sink`)
	}
	if (!Array.isArray(config.loggers)) throw new TypeError(`${label}.loggers must be an array`)
}

/** Host-only settings have their own closed, independent contract. */
export function assertRuntimeLoggingOptions(input: unknown): void {
	const options = configObject(input, '[core.logtape] options')
	assertKnownConfigFields(options, LOGGING_OPTIONS_FIELDS, '[core.logtape] options')
	if (
		options.profile !== undefined &&
		(typeof options.profile !== 'string' || !options.profile.trim())
	)
		throw new TypeError('[core.logtape] options.profile must be a nonempty string')
	if (
		options.debugTopics !== undefined &&
		(!Array.isArray(options.debugTopics) ||
			options.debugTopics.some((topic) => typeof topic !== 'string'))
	)
		throw new TypeError('[core.logtape] options.debugTopics must be a string array')
	if (
		options.policyLoadFailure !== undefined &&
		options.policyLoadFailure !== 'warn' &&
		options.policyLoadFailure !== 'fail'
	)
		throw new TypeError('[core.logtape] options.policyLoadFailure must be warn or fail')
	if (options.initialPluginPolicy !== undefined)
		normalizePluginLogPolicySnapshot(options.initialPluginPolicy)
}
