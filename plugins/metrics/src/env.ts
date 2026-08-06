const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/metrics'
const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_TIMEOUT_MS = 30_000

const MAX_ENDPOINT_BYTES = 2_048
const MAX_HEADER_ENTRIES = 32
const MAX_HEADER_BYTES = 16 * 1_024
const MAX_RESOURCE_ENTRIES = 64
const MAX_RESOURCE_BYTES = 32 * 1_024
const MIN_INTERVAL_MS = 1_000
const MAX_INTERVAL_MS = 300_000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 30_000

type Environment = Readonly<Record<string, string | undefined>>

export type ResolvedOtlpConfig = Readonly<{
	endpoint: string
	headers: Readonly<Record<string, string>>
	resourceAttributes: Readonly<Record<string, string>>
	intervalMs: number
	timeoutMs: number
}>

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function invalid(variable: string, expectation: string): TypeError {
	return new TypeError('Invalid ' + variable + ': ' + expectation)
}

function optionalValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

function decodePairPart(value: string, variable: string, index: number): string {
	try {
		return decodeURIComponent(value.trim())
	} catch {
		throw invalid(variable, 'entry ' + (index + 1) + ' must use valid percent-encoding')
	}
}

function parsePairs(
	raw: string | undefined,
	options: Readonly<{
		variable: string
		maxEntries: number
		maxBytes: number
		normalizeKey?: (key: string, value: string) => string
	}>,
): Readonly<Record<string, string>> {
	if (raw === undefined || raw.trim() === '') return Object.freeze({})
	if (utf8Bytes(raw) > options.maxBytes) {
		throw invalid(options.variable, 'encoded value exceeds ' + options.maxBytes + ' UTF-8 bytes')
	}

	const entries = raw.split(',')
	if (entries.length > options.maxEntries) {
		throw invalid(options.variable, 'expected at most ' + options.maxEntries + ' entries')
	}

	const result = Object.create(null) as Record<string, string>
	let decodedBytes = 0
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!
		const separator = entry.indexOf('=')
		if (separator <= 0) {
			throw invalid(options.variable, 'entry ' + (index + 1) + ' must be key=value')
		}
		const value = decodePairPart(entry.slice(separator + 1), options.variable, index)
		let key = decodePairPart(entry.slice(0, separator), options.variable, index)
		if (!key) throw invalid(options.variable, 'entry ' + (index + 1) + ' has an empty key')
		key = options.normalizeKey?.(key, value) ?? key
		if (Object.hasOwn(result, key)) {
			throw invalid(options.variable, 'entry ' + (index + 1) + ' duplicates a key')
		}
		decodedBytes += utf8Bytes(key) + utf8Bytes(value)
		if (decodedBytes > options.maxBytes) {
			throw invalid(options.variable, 'decoded value exceeds ' + options.maxBytes + ' UTF-8 bytes')
		}
		result[key] = value
	}
	return Object.freeze(result)
}

function normalizeHeaderName(key: string, value: string): string {
	try {
		for (let index = 0; index < value.length; index += 1) {
			const code = value.charCodeAt(index)
			if ((code <= 31 && code !== 9) || code === 127) {
				throw new TypeError('control character')
			}
		}
		const headers = new Headers()
		headers.set(key, value)
		return key.toLowerCase()
	} catch {
		throw new TypeError('OTLP header entry must use a valid HTTP field name and value')
	}
}

function parseInteger(
	env: Environment,
	variable: string,
	defaultValue: number,
	min: number,
	max: number,
): number {
	const raw = optionalValue(env[variable])
	if (raw === undefined) return defaultValue
	if (!/^[0-9]+$/.test(raw)) {
		throw invalid(variable, 'expected an integer from ' + min + ' to ' + max)
	}
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw invalid(variable, 'expected an integer from ' + min + ' to ' + max)
	}
	return value
}

function resolveEndpoint(env: Environment): string {
	const metricsEndpoint = optionalValue(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
	const genericEndpoint = optionalValue(env.OTEL_EXPORTER_OTLP_ENDPOINT)
	const raw = metricsEndpoint ?? genericEndpoint ?? DEFAULT_ENDPOINT
	if (utf8Bytes(raw) > MAX_ENDPOINT_BYTES) {
		throw invalid('OTLP metrics endpoint', 'expected at most 2048 UTF-8 bytes')
	}

	let endpoint: URL
	try {
		endpoint = new URL(raw)
	} catch {
		throw invalid('OTLP metrics endpoint', 'expected an absolute http: or https: URL')
	}
	if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
		throw invalid('OTLP metrics endpoint', 'expected an http: or https: URL')
	}
	if (endpoint.username || endpoint.password) {
		throw invalid('OTLP metrics endpoint', 'URL userinfo is not allowed; use OTLP headers')
	}
	if (genericEndpoint && !metricsEndpoint) {
		const basePath = endpoint.pathname.endsWith('/')
			? endpoint.pathname.slice(0, -1)
			: endpoint.pathname
		endpoint.pathname = basePath + '/v1/metrics'
	}
	const resolved = endpoint.toString()
	if (utf8Bytes(resolved) > MAX_ENDPOINT_BYTES) {
		throw invalid('OTLP metrics endpoint', 'resolved URL exceeds 2048 UTF-8 bytes')
	}
	return resolved
}

function resolveProtocol(env: Environment): void {
	const protocol =
		optionalValue(env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL) ??
		optionalValue(env.OTEL_EXPORTER_OTLP_PROTOCOL) ??
		'http/protobuf'
	if (protocol !== 'http/protobuf') {
		throw invalid('OTLP metrics protocol', 'only http/protobuf is supported')
	}
}

function resolveHeaders(env: Environment): Readonly<Record<string, string>> {
	const specific = optionalValue(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS)
	const raw = specific ?? optionalValue(env.OTEL_EXPORTER_OTLP_HEADERS)
	return parsePairs(raw, {
		variable: specific ? 'OTEL_EXPORTER_OTLP_METRICS_HEADERS' : 'OTEL_EXPORTER_OTLP_HEADERS',
		maxEntries: MAX_HEADER_ENTRIES,
		maxBytes: MAX_HEADER_BYTES,
		normalizeKey: normalizeHeaderName,
	})
}

function resolveResourceAttributes(
	env: Environment,
	rootName: string,
): Readonly<Record<string, string>> {
	const attributes = {
		...parsePairs(optionalValue(env.OTEL_RESOURCE_ATTRIBUTES), {
			variable: 'OTEL_RESOURCE_ATTRIBUTES',
			maxEntries: MAX_RESOURCE_ENTRIES,
			maxBytes: MAX_RESOURCE_BYTES,
		}),
	}
	const serviceName = optionalValue(env.OTEL_SERVICE_NAME) ?? attributes['service.name'] ?? rootName
	attributes['service.name'] = serviceName
	const entries = Object.entries(attributes)
	if (entries.length > MAX_RESOURCE_ENTRIES) {
		throw invalid('OTLP resource attributes', 'expected at most 64 entries')
	}
	const bytes = entries.reduce(
		(total, [key, value]) => total + utf8Bytes(key) + utf8Bytes(value),
		0,
	)
	if (bytes > MAX_RESOURCE_BYTES) {
		throw invalid('OTLP resource attributes', 'expected at most 32768 UTF-8 bytes')
	}
	return Object.freeze(attributes)
}

export function resolveOtlpConfig(env: Environment, rootName: string): ResolvedOtlpConfig {
	resolveProtocol(env)
	const intervalMs = parseInteger(
		env,
		'OTEL_METRIC_EXPORT_INTERVAL',
		DEFAULT_INTERVAL_MS,
		MIN_INTERVAL_MS,
		MAX_INTERVAL_MS,
	)
	const timeoutMs = parseInteger(
		env,
		'OTEL_METRIC_EXPORT_TIMEOUT',
		DEFAULT_TIMEOUT_MS,
		MIN_TIMEOUT_MS,
		MAX_TIMEOUT_MS,
	)
	if (timeoutMs > intervalMs) {
		throw invalid('OTEL_METRIC_EXPORT_TIMEOUT', 'must not exceed OTEL_METRIC_EXPORT_INTERVAL')
	}
	return Object.freeze({
		endpoint: resolveEndpoint(env),
		headers: resolveHeaders(env),
		resourceAttributes: resolveResourceAttributes(env, rootName),
		intervalMs,
		timeoutMs,
	})
}
