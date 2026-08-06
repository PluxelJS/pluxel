export const MAX_OPERATIONS = 1_024
export const MAX_OPERATIONS_PER_PLUGIN = 128
export const MAX_OPERATION_NAME_BYTES = 128

export const DURATION_BUCKETS_SECONDS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const

export const METRIC_CALLS = 'pluxel.plugin.operation.calls'
export const METRIC_DURATION = 'pluxel.plugin.operation.duration'
export const METRIC_CAPACITY_DROPS = 'pluxel.metrics.operation_limit.drops'

export const ATTR_PLUGIN_ID = 'pluxel.plugin.id'
export const ATTR_OPERATION_NAME = 'pluxel.operation.name'
export const ATTR_OPERATION_RESULT = 'pluxel.operation.result'
export const ATTR_CAPACITY_LIMIT = 'pluxel.metrics.limit'

export const EXPORT_FAILURE_LOG_INTERVAL_MS = 60_000
