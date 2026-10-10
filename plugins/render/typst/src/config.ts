import * as v from 'valibot'

const positive = (fallback: number) =>
	v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
		fallback,
	)

/** Execution budgets, independent of application document data. */
export const TypstConfig = v.object({
	maxSessions: positive(4),
	maxQueuedUpdates: positive(8),
	maxFiles: positive(4096),
	maxTemplateBytes: positive(64 * 1024 * 1024),
	maxInputBytes: positive(256 * 1024 * 1024),
	maxOutputBytes: positive(64 * 1024 * 1024),
	maxFontBytes: positive(64 * 1024 * 1024),
	maxJsonDepth: positive(64),
	maxJsonValues: positive(1_000_000),
})
export type TypstPluginConfig = v.InferOutput<typeof TypstConfig>
