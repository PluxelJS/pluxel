import type { OtelSignal } from './config.ts'

const DEFAULT_HTTP_ENDPOINT = 'http://localhost:4318'
const DEFAULT_GRPC_ENDPOINT = 'http://localhost:4317'
const DEFAULT_OTLP_TIMEOUT_MS = 10_000
const DEFAULT_METRIC_INTERVAL_MS = 60_000
const DEFAULT_PROCESSOR_TIMEOUT_MS = 30_000

const MAX_ENDPOINT_BYTES = 2_048
const MAX_HEADER_ENTRIES = 32
const MAX_HEADER_BYTES = 16 * 1_024
const MAX_RESOURCE_ENTRIES = 64
const MAX_RESOURCE_BYTES = 32 * 1_024
const MIN_INTERVAL_MS = 1_000
const MAX_INTERVAL_MS = 300_000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 30_000
const MAX_QUEUE_SIZE = 65_536
const MAX_BATCH_SIZE = 8_192

const SIGNAL_ENV = {
	metrics: 'METRICS',
	traces: 'TRACES',
	logs: 'LOGS',
} as const satisfies Record<OtelSignal, string>

export type OtelEnvironment = Readonly<Record<string, string | undefined>>
export type OtlpProtocol = 'grpc' | 'http/protobuf' | 'http/json'
export type OtlpCompression = 'none' | 'gzip'

export type ResolvedOtlpConfig = Readonly<{
	signal: OtelSignal
	protocol: OtlpProtocol
	endpoint: string
	headers: Readonly<Record<string, string>>
	timeoutMs: number
	compression: OtlpCompression
}>

export type ResolvedMetricReaderConfig = Readonly<{
	intervalMs: number
	timeoutMs: number
}>

export type ResolvedBatchProcessorConfig = Readonly<{
	maxQueueSize: number
	maxExportBatchSize: number
	scheduledDelayMillis: number
	exportTimeoutMillis: number
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
			if ((code <= 31 && code !== 9) || code === 127) throw new TypeError('control character')
		}
		const headers = new Headers()
		headers.set(key, value)
		return key.toLowerCase()
	} catch {
		throw new TypeError('OTLP header entry must use a valid field name and value')
	}
}

function parseInteger(
	env: OtelEnvironment,
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

function resolveProtocol(env: OtelEnvironment, signal: OtelSignal): OtlpProtocol {
	const signalKey = 'OTEL_EXPORTER_OTLP_' + SIGNAL_ENV[signal] + '_PROTOCOL'
	const protocol = optionalValue(env[signalKey]) ?? optionalValue(env.OTEL_EXPORTER_OTLP_PROTOCOL)
	if (protocol === undefined) return 'http/protobuf'
	if (protocol === 'grpc' || protocol === 'http/protobuf' || protocol === 'http/json')
		return protocol
	throw invalid(signalKey, 'expected grpc, http/protobuf, or http/json')
}

function validateHttpEndpoint(raw: string, label: string): string {
	let endpoint: URL
	try {
		endpoint = new URL(raw)
	} catch {
		throw invalid(label, 'expected an absolute http: or https: URL')
	}
	if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
		throw invalid(label, 'expected an http: or https: URL')
	}
	if (endpoint.username || endpoint.password) {
		throw invalid(label, 'URL userinfo is not allowed; use OTLP headers')
	}
	return endpoint.toString()
}

function validateGrpcEndpoint(raw: string, label: string): string {
	let endpoint: URL
	try {
		endpoint = new URL(raw.includes('://') ? raw : 'https://' + raw)
	} catch {
		throw invalid(label, 'expected an OTLP gRPC target')
	}
	if (!['http:', 'https:', 'unix:'].includes(endpoint.protocol)) {
		throw invalid(label, 'expected http:, https:, unix:, or a host:port target')
	}
	if (endpoint.username || endpoint.password) {
		throw invalid(label, 'URL userinfo is not allowed; use OTLP headers')
	}
	if (endpoint.protocol !== 'unix:' && endpoint.pathname !== '/' && endpoint.pathname !== '') {
		throw invalid(label, 'gRPC endpoints must not contain a path')
	}
	return raw
}

function resolveEndpoint(env: OtelEnvironment, signal: OtelSignal, protocol: OtlpProtocol): string {
	const signalKey = 'OTEL_EXPORTER_OTLP_' + SIGNAL_ENV[signal] + '_ENDPOINT'
	const specificEndpoint = optionalValue(env[signalKey])
	const genericEndpoint = optionalValue(env.OTEL_EXPORTER_OTLP_ENDPOINT)
	let raw: string
	if (protocol === 'grpc') {
		raw = specificEndpoint ?? genericEndpoint ?? DEFAULT_GRPC_ENDPOINT
	} else if (specificEndpoint) {
		raw = specificEndpoint
	} else {
		const base = genericEndpoint ?? DEFAULT_HTTP_ENDPOINT
		const endpoint = validateHttpEndpoint(
			base,
			genericEndpoint ? 'OTEL_EXPORTER_OTLP_ENDPOINT' : 'OTLP endpoint',
		)
		const url = new URL(endpoint)
		url.pathname = url.pathname.replace(/\/$/, '') + '/v1/' + signal
		raw = url.toString()
	}

	if (utf8Bytes(raw) > MAX_ENDPOINT_BYTES) {
		throw invalid(
			specificEndpoint ? signalKey : 'OTEL_EXPORTER_OTLP_ENDPOINT',
			'expected at most 2048 UTF-8 bytes',
		)
	}
	const label = specificEndpoint ? signalKey : 'OTEL_EXPORTER_OTLP_ENDPOINT'
	const resolved =
		protocol === 'grpc' ? validateGrpcEndpoint(raw, label) : validateHttpEndpoint(raw, label)
	if (utf8Bytes(resolved) > MAX_ENDPOINT_BYTES) {
		throw invalid(label, 'resolved URL exceeds 2048 UTF-8 bytes')
	}
	return resolved
}

function resolveHeaders(
	env: OtelEnvironment,
	signal: OtelSignal,
): Readonly<Record<string, string>> {
	const signalKey = 'OTEL_EXPORTER_OTLP_' + SIGNAL_ENV[signal] + '_HEADERS'
	const generic = parsePairs(optionalValue(env.OTEL_EXPORTER_OTLP_HEADERS), {
		variable: 'OTEL_EXPORTER_OTLP_HEADERS',
		maxEntries: MAX_HEADER_ENTRIES,
		maxBytes: MAX_HEADER_BYTES,
		normalizeKey: normalizeHeaderName,
	})
	const specific = parsePairs(optionalValue(env[signalKey]), {
		variable: signalKey,
		maxEntries: MAX_HEADER_ENTRIES,
		maxBytes: MAX_HEADER_BYTES,
		normalizeKey: normalizeHeaderName,
	})
	const headers = { ...generic, ...specific }
	if (Object.keys(headers).length > MAX_HEADER_ENTRIES) {
		throw invalid('OTLP headers', 'expected at most 32 merged entries')
	}
	if (
		Object.entries(headers).reduce(
			(total, [key, value]) => total + utf8Bytes(key) + utf8Bytes(value),
			0,
		) > MAX_HEADER_BYTES
	) {
		throw invalid('OTLP headers', 'merged value exceeds 16384 UTF-8 bytes')
	}
	return Object.freeze(headers)
}

function resolveCompression(env: OtelEnvironment, signal: OtelSignal): OtlpCompression {
	const signalKey = 'OTEL_EXPORTER_OTLP_' + SIGNAL_ENV[signal] + '_COMPRESSION'
	const compression =
		optionalValue(env[signalKey]) ?? optionalValue(env.OTEL_EXPORTER_OTLP_COMPRESSION)
	if (compression === undefined) return 'none'
	if (compression === 'none' || compression === 'gzip') return compression
	throw invalid(signalKey, 'expected none or gzip')
}

export function resolveResourceAttributes(
	env: OtelEnvironment,
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

export function resolveMetricReaderConfig(env: OtelEnvironment): ResolvedMetricReaderConfig {
	const intervalMs = parseInteger(
		env,
		'OTEL_METRIC_EXPORT_INTERVAL',
		DEFAULT_METRIC_INTERVAL_MS,
		MIN_INTERVAL_MS,
		MAX_INTERVAL_MS,
	)
	const timeoutMs = parseInteger(
		env,
		'OTEL_METRIC_EXPORT_TIMEOUT',
		DEFAULT_PROCESSOR_TIMEOUT_MS,
		MIN_TIMEOUT_MS,
		MAX_TIMEOUT_MS,
	)
	if (timeoutMs > intervalMs) {
		throw invalid('OTEL_METRIC_EXPORT_TIMEOUT', 'must not exceed OTEL_METRIC_EXPORT_INTERVAL')
	}
	return Object.freeze({ intervalMs, timeoutMs })
}

export function resolveBatchProcessorConfig(
	env: OtelEnvironment,
	signal: 'traces' | 'logs',
): ResolvedBatchProcessorConfig {
	const prefix = signal === 'traces' ? 'OTEL_BSP_' : 'OTEL_BLRP_'
	const maxQueueSize = parseInteger(env, prefix + 'MAX_QUEUE_SIZE', 2_048, 1, MAX_QUEUE_SIZE)
	const maxExportBatchSize = parseInteger(
		env,
		prefix + 'MAX_EXPORT_BATCH_SIZE',
		512,
		1,
		MAX_BATCH_SIZE,
	)
	if (maxExportBatchSize > maxQueueSize) {
		throw invalid(prefix + 'MAX_EXPORT_BATCH_SIZE', 'must not exceed ' + prefix + 'MAX_QUEUE_SIZE')
	}
	return Object.freeze({
		maxQueueSize,
		maxExportBatchSize,
		scheduledDelayMillis: parseInteger(
			env,
			prefix + 'SCHEDULE_DELAY',
			signal === 'traces' ? 5_000 : 1_000,
			1,
			MAX_INTERVAL_MS,
		),
		exportTimeoutMillis: parseInteger(
			env,
			prefix + 'EXPORT_TIMEOUT',
			DEFAULT_PROCESSOR_TIMEOUT_MS,
			MIN_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
		),
	})
}

export function resolveOtlpConfig(env: OtelEnvironment, signal: OtelSignal): ResolvedOtlpConfig {
	const protocol = resolveProtocol(env, signal)
	const signalKey = 'OTEL_EXPORTER_OTLP_' + SIGNAL_ENV[signal] + '_TIMEOUT'
	return Object.freeze({
		signal,
		protocol,
		endpoint: resolveEndpoint(env, signal, protocol),
		headers: resolveHeaders(env, signal),
		timeoutMs: parseInteger(
			env,
			signalKey,
			parseInteger(
				env,
				'OTEL_EXPORTER_OTLP_TIMEOUT',
				DEFAULT_OTLP_TIMEOUT_MS,
				MIN_TIMEOUT_MS,
				MAX_TIMEOUT_MS,
			),
			MIN_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
		),
		compression: resolveCompression(env, signal),
	})
}
