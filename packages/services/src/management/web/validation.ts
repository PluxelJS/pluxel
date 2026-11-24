import { parseFormFields } from 'valibot-form'
import {
	RUNTIME_MANAGEMENT_CAPABILITIES,
	RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
	type ConfigPresentationPlanV3,
	type RuntimeJsonValue,
	type RuntimeManagementCapability,
	type RuntimeMeta,
} from './protocol'
import { readProductDescriptor } from '../product-contract'

const MAX_TREE_DEPTH = 32
const MAX_ARRAY_ITEMS = 10_000
const MAX_OBJECT_FIELDS = 10_000
const MAX_TEXT_LENGTH = 1_000_000
const MAX_TOTAL_NODES = 50_000
const MAX_TOTAL_TEXT = 4_000_000

type ValidationBudget = { nodes: number; text: number }

export class RuntimeProtocolValidationError extends TypeError {
	constructor(message: string) {
		super(message)
		this.name = 'RuntimeProtocolValidationError'
	}
}

/** Clone one untrusted wire value into a deeply frozen portable-data tree. */
export function parseRuntimePortableData(input: unknown, label = 'value'): RuntimeJsonValue {
	return visitPortable(input, label, new Set(), 0, { nodes: 0, text: 0 }, true, false)
}

/** @internal Inspect a borrowed result before domain parsers construct owned values. */
export function validateRuntimePortableData(
	input: unknown,
	label: string,
	rejectReservedFields = false,
): asserts input is RuntimeJsonValue {
	visitPortable(input, label, new Set(), 0, { nodes: 0, text: 0 }, false, rejectReservedFields)
}

export function parseConfigFieldPathSegments(
	input: unknown,
	label = 'fieldPath',
): readonly string[] {
	if (typeof input !== 'string') fail(`${label} must be a string`)
	const fieldPath = input.trim()
	if (!fieldPath || fieldPath.length > 512) {
		fail(`${label} must contain between 1 and 512 characters`)
	}
	return pathSegments(
		fieldPath.split('.').map((segment) => segment.trim()),
		label,
		false,
	)
}

/** Validate, clone, and freeze runtime discovery received from an untrusted host. */
export function parseRuntimeMeta(input: unknown): RuntimeMeta {
	validateRuntimePortableData(input, 'runtime metadata')
	const meta = record(input, 'runtime metadata')
	exact(
		meta,
		['service', 'ready', 'protocol', 'application', 'platform', 'workbench'],
		'runtime metadata',
	)
	if (meta.service !== 'pluxel-runtime') fail('runtime metadata.service must be pluxel-runtime')
	if (meta.ready !== true) fail('runtime metadata.ready must be true')

	const protocol = record(meta.protocol, 'runtime metadata.protocol')
	exact(protocol, ['name', 'major', 'capabilities'], 'runtime metadata.protocol')
	if (protocol.name !== 'pluxel.management') {
		fail('runtime metadata.protocol.name must be pluxel.management')
	}
	if (protocol.major !== RUNTIME_MANAGEMENT_PROTOCOL_MAJOR)
		fail(`runtime metadata.protocol.major must be ${RUNTIME_MANAGEMENT_PROTOCOL_MAJOR}`)
	const capabilities = closedStringArray<RuntimeManagementCapability>(
		protocol.capabilities,
		RUNTIME_MANAGEMENT_CAPABILITIES,
		'runtime metadata.protocol.capabilities',
	)

	const application = record(meta.application, 'runtime metadata.application')
	exact(application, ['product'], 'runtime metadata.application')
	if (!Object.hasOwn(application, 'product')) {
		fail('runtime metadata.application.product is required')
	}
	let product = null
	if (application.product !== null) {
		try {
			product = readProductDescriptor(application.product, 'runtime metadata.application.product')
		} catch (error) {
			fail(
				error instanceof Error ? error.message : 'runtime metadata.application.product is invalid',
			)
		}
	}

	const workbench = record(meta.workbench, 'runtime metadata.workbench')
	exact(workbench, ['enabled'], 'runtime metadata.workbench')
	if (typeof workbench.enabled !== 'boolean') {
		fail('runtime metadata.workbench.enabled must be boolean')
	}

	const platform = platformSnapshot(meta.platform)
	return Object.freeze({
		service: 'pluxel-runtime' as const,
		ready: true as const,
		protocol: Object.freeze({
			name: 'pluxel.management' as const,
			major: RUNTIME_MANAGEMENT_PROTOCOL_MAJOR,
			capabilities,
		}),
		application: Object.freeze({ product }),
		platform,
		workbench: Object.freeze({ enabled: workbench.enabled }),
	})
}

function platformSnapshot(input: unknown): RuntimeMeta['platform'] {
	const snapshot = record(input, 'runtime metadata.platform')
	exact(snapshot, ['runtime', 'deployment', 'mode', 'platform'], 'runtime metadata.platform')
	const runtime = record(snapshot.runtime, 'runtime metadata.platform.runtime')
	exact(runtime, ['name', 'version'], 'runtime metadata.platform.runtime')
	const deployment = record(snapshot.deployment, 'runtime metadata.platform.deployment')
	exact(deployment, ['provider', 'ci'], 'runtime metadata.platform.deployment')
	const runtimeName = nullableString(runtime.name, 'runtime metadata.platform.runtime.name')
	const runtimeVersion = nullableString(
		runtime.version,
		'runtime metadata.platform.runtime.version',
	)
	const deploymentProvider = nullableString(
		deployment.provider,
		'runtime metadata.platform.deployment.provider',
	)
	if (typeof deployment.ci !== 'boolean') {
		fail('runtime metadata.platform.deployment.ci must be boolean')
	}
	const mode = enumValue(
		snapshot.mode,
		['development', 'production', 'test', 'unknown'],
		'runtime metadata.platform.mode',
	)
	const platform = nullableString(snapshot.platform, 'runtime metadata.platform.platform')
	return Object.freeze({
		runtime: Object.freeze({ name: runtimeName, version: runtimeVersion }),
		deployment: Object.freeze({ provider: deploymentProvider, ci: deployment.ci }),
		mode,
		platform,
	})
}

function nullableString(input: unknown, label: string): string | null {
	if (input === null) return null
	if (typeof input === 'string') return input
	fail(`${label} must be a string or null`)
}

/** Validate the version and declaration sections before reading the shared field tree. */
export function parseConfigPresentationPlanV3(input: unknown): ConfigPresentationPlanV3 {
	validateRuntimePortableData(input, 'config presentation plan')
	const plan = record(input, 'plan')
	exact(plan, ['version', 'sections'], 'plan')
	if (plan.version !== 3) fail('plan.version must be 3')
	if (!Array.isArray(plan.sections)) fail('plan.sections must be an array')
	const paths = new Set<string>()
	const sections = plan.sections.map((inputSection, index) => {
		const label = `plan.sections[${index}]`
		const section = record(inputSection, label)
		exact(section, ['path', 'fieldName', 'fields'], label)
		const path = pathSegments(section.path, `${label}.path`, true)
		const key = JSON.stringify(path)
		if (paths.has(key)) fail(`${label}.path duplicates a declaration section`)
		paths.add(key)
		const fieldName = text(section.fieldName, `${label}.fieldName`)
		try {
			return Object.freeze({ path, fieldName, fields: parseFormFields(section.fields) })
		} catch (error) {
			if (error instanceof TypeError) fail(`${label}.fields: ${error.message}`)
			throw error
		}
	})
	return Object.freeze({ version: 3 as const, sections: Object.freeze(sections) })
}

function pathSegments(input: unknown, label: string, allowEmpty: boolean): readonly string[] {
	if (!Array.isArray(input)) fail(`${label} must be a string array`)
	if ((!allowEmpty && input.length === 0) || input.length > 32) {
		fail(`${label} must contain ${allowEmpty ? 'between 0 and' : 'between 1 and'} 32 segments`)
	}
	const segments = input.map((segment, index) => {
		if (typeof segment !== 'string') fail(`${label}[${index}] must be a string`)
		if (!segment || segment.length > 128) {
			fail(`${label}[${index}] must contain between 1 and 128 characters`)
		}
		if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
			fail(`${label}[${index}] is reserved`)
		}
		return segment
	})
	if (segments.join('.').length > 512) fail(`${label} exceeds 512 characters`)
	return Object.freeze(segments)
}

function enumValue<const T extends string>(input: unknown, values: readonly T[], label: string): T {
	if (typeof input !== 'string' || !values.includes(input as T)) {
		fail(`${label} must be one of ${values.join(', ')}`)
	}
	return input as T
}

function closedStringArray<const T extends string>(
	input: unknown,
	allowed: readonly T[],
	label: string,
): readonly T[] {
	if (!Array.isArray(input)) fail(`${label} must be an array`)
	const allowedValues = new Set<string>(allowed)
	const seen = new Set<string>()
	const output = input.map((value, index) => {
		if (typeof value !== 'string' || !allowedValues.has(value)) {
			fail(`${label}[${index}] is unsupported`)
		}
		if (seen.has(value)) fail(`${label} contains duplicate value ${value}`)
		seen.add(value)
		return value as T
	})
	return Object.freeze(output)
}

function exact(
	recordValue: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const allowedFields = new Set(allowed)
	const extra = Object.keys(recordValue).filter((key) => !allowedFields.has(key))
	if (extra.length > 0) fail(`${label} contains unsupported field ${extra[0]}`)
}

function visitPortable(
	input: unknown,
	label: string,
	ancestors: Set<object>,
	depth: number,
	budget: ValidationBudget,
	copy: boolean,
	rejectReservedFields: boolean,
): RuntimeJsonValue {
	if (++budget.nodes > MAX_TOTAL_NODES) fail(`${label} exceeds total node budget`)
	if (depth > MAX_TREE_DEPTH * 2) fail(`${label} exceeds maximum nesting depth`)
	if (typeof input === 'string') {
		consumeText(input, label, budget)
		return input
	}
	if (input === null) return null
	if (typeof input === 'boolean') return input
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) fail(`${label} must be a finite number`)
		return input
	}
	if (typeof input !== 'object') fail(`${label} is not portable data`)
	if (ancestors.has(input)) fail(`${label} contains a cycle`)
	ancestors.add(input)
	try {
		const isArray = Array.isArray(input)
		const prototype = Object.getPrototypeOf(input)
		if (
			isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
		) {
			fail(`${label} must be a plain ${isArray ? 'array' : 'object'}`)
		}
		if (Object.getOwnPropertySymbols(input).length > 0) fail(`${label} must not contain symbols`)
		const descriptors = Object.getOwnPropertyDescriptors(input)
		const keys = Object.keys(descriptors)
		if (isArray) {
			if (input.length > MAX_ARRAY_ITEMS) fail(`${label} exceeds ${MAX_ARRAY_ITEMS} items`)
			if (keys.length !== input.length + 1)
				fail(`${label} must be a dense array without extra fields`)
		} else if (keys.length > MAX_OBJECT_FIELDS) fail(`${label} has too many fields`)
		const out = copy ? (isArray ? [] : {}) : undefined
		for (const key of keys) {
			if (isArray && key === 'length') continue
			if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) {
				fail(`${label} contains unsupported array field ${key}`)
			}
			if (
				rejectReservedFields &&
				(key === '__proto__' || key === 'prototype' || key === 'constructor')
			) {
				fail(`${label} contains reserved field ${key}`)
			}
			if (!isArray) consumeText(key, `${label} key`, budget)
			const descriptor = descriptors[key]!
			if (!('value' in descriptor)) fail(`${label}.${key} must be a data property`)
			if (!descriptor.enumerable) fail(`${label}.${key} must be enumerable`)
			const value = visitPortable(
				descriptor.value,
				isArray ? `${label}[${key}]` : `${label}.${key}`,
				ancestors,
				depth + 1,
				budget,
				copy,
				rejectReservedFields,
			)
			if (out) defineRecordField(out as Record<string, unknown>, key, value)
		}
		return (out ? Object.freeze(out) : input) as RuntimeJsonValue
	} finally {
		ancestors.delete(input)
	}
}

function defineRecordField<Value>(target: Record<string, Value>, key: string, value: Value): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	})
}

function consumeText(input: string, label: string, budget: ValidationBudget): void {
	if (input.length > MAX_TEXT_LENGTH) fail(`${label} exceeds maximum string length`)
	budget.text += input.length
	if (budget.text > MAX_TOTAL_TEXT) fail(`${label} exceeds total text budget`)
}

function record(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		fail(`${label} must be an object`)
	return input as Record<string, unknown>
}

function text(input: unknown, label: string): string {
	if (typeof input !== 'string') fail(`${label} must be a string`)
	return input
}

function fail(message: string): never {
	throw new RuntimeProtocolValidationError(message)
}
