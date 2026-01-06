import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
import { matchesTopic, normalizeTopic } from './topic'

export type DebugTopic = string

const DEBUG_CATEGORY = ['pluxel', 'debug'] as const

export function resolveDebugTopics(config: unknown): DebugTopic[] {
	const raw = (config as any)?.debug as unknown
	const list = Array.isArray(raw) ? raw : raw ? [raw] : []
	const out: string[] = []
	for (const v of list) {
		const s = normalizeTopic(v)
		if (!s) continue
		out.push(s)
	}
	return Array.from(new Set(out))
}

export function isDebugTopicEnabled(config: unknown, topic: DebugTopic): boolean {
	const t = normalizeTopic(topic)
	if (!t) return false
	const patterns = resolveDebugTopics(config)
	for (const p of patterns) {
		if (matchesTopic(p, t)) return true
	}
	return false
}

/**
 * Create a LogTape logger for a debug topic.
 *
 * Implementation:
 * - category is fixed to `["pluxel","debug"]` so hosts can route it to dedicated sinks.
 * - `debugTopic` is attached into record properties for filtering and pretty labeling.
 */
export function getDebugLogger(topic: string): LogtapeLogger {
	return getLogger(DEBUG_CATEGORY).with({ debugTopic: topic })
}
