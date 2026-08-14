import { v } from '@pluxel/runtime'

export type OtelSignal = 'metrics' | 'traces' | 'logs'

function hasUniqueSignals(signals: OtelSignal[]): boolean {
	return new Set(signals).size === signals.length
}

function hasOutput(config: {
	otlp?: OtelSignal[]
	prometheus?: false | { path?: string }
}): boolean {
	return (
		(config.otlp?.length ?? 3) > 0 ||
		(config.prometheus !== undefined && config.prometheus !== false)
	)
}

function isPluginRoutePath(path: string): boolean {
	return (
		path !== '/' &&
		path.startsWith('/') &&
		!path.endsWith('/') &&
		!path.includes('//') &&
		!path.includes('?') &&
		!path.includes('#') &&
		!path.includes('\\') &&
		!path.includes('\0')
	)
}

const PrometheusConfig = v.object({
	path: v.optional(
		v.pipe(
			v.string(),
			v.maxLength(256),
			v.check(
				isPluginRoutePath,
				'prometheus.path must be a non-root absolute plugin route without a trailing slash, query, hash, backslash, or empty segment',
			),
		),
		'/metrics',
	),
})

export const OtelConfig = v.pipe(
	v.object({
		otlp: v.optional(
			v.pipe(
				v.array(v.picklist(['metrics', 'traces', 'logs'] as const)),
				v.maxLength(3),
				v.check(hasUniqueSignals, 'otlp must not contain duplicate signals'),
			),
			['metrics', 'traces', 'logs'],
		),
		prometheus: v.optional(v.union([v.literal(false), PrometheusConfig]), false),
	}),
	v.check(hasOutput, 'at least one OTLP signal or Prometheus output must be enabled'),
)

export type OtelPluginConfig = v.InferOutput<typeof OtelConfig>
