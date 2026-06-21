import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { LogLevel, LogRecord } from '@logtape/logtape'
import { dirname } from 'pathe'

export type RuntimePluginLogLevel = LogLevel | 'off'

export type PluginLogPolicySnapshot = {
	defaultLevel?: RuntimePluginLogLevel
	overrides: Record<string, RuntimePluginLogLevel>
}

const LEVEL_RANK: Record<LogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warning: 40,
	error: 50,
	fatal: 60,
}

function normalizeLevel(level: RuntimePluginLogLevel | undefined) {
	if (level === undefined) return undefined
	if (level === 'off') return 'off' as const
	if (level === 'warn') return 'warning' as const
	if (
		level === 'trace' ||
		level === 'debug' ||
		level === 'info' ||
		level === 'warning' ||
		level === 'error' ||
		level === 'fatal'
	) {
		return level
	}
	throw new Error(`Invalid plugin log level: ${String(level)}`)
}

function toRank(level: RuntimePluginLogLevel | undefined): number | null | undefined {
	if (level === undefined) return undefined
	if (level === 'off') return null
	return LEVEL_RANK[level]
}

function normalizeSnapshot(input: Partial<PluginLogPolicySnapshot> = {}): PluginLogPolicySnapshot {
	const defaultLevel = normalizeLevel(input.defaultLevel)
	const overrides: Record<string, RuntimePluginLogLevel> = {}
	for (const [pluginId, raw] of Object.entries(input.overrides ?? {})) {
		if (!pluginId) continue
		const level = normalizeLevel(raw)
		if (level !== undefined) overrides[pluginId] = level
	}
	return defaultLevel === undefined ? { overrides } : { defaultLevel, overrides }
}

function recordPluginId(record: LogRecord): string | undefined {
	const props = record.properties
	if (!props || typeof props !== 'object') return undefined
	const pluginId = (props as Record<string, unknown>).pluginId
	return typeof pluginId === 'string' && pluginId ? pluginId : undefined
}

export class RuntimePluginLogPolicy {
	private defaultLevel: RuntimePluginLogLevel | undefined
	private defaultRank: number | null | undefined
	private readonly overrides = new Map<string, RuntimePluginLogLevel>()
	private readonly ranks = new Map<string, number | null>()

	constructor(snapshot: Partial<PluginLogPolicySnapshot> = {}) {
		this.replace(snapshot)
	}

	snapshot(): PluginLogPolicySnapshot {
		const overrides: Record<string, RuntimePluginLogLevel> = {}
		for (const [pluginId, level] of this.overrides) overrides[pluginId] = level
		return this.defaultLevel === undefined
			? { overrides }
			: { defaultLevel: this.defaultLevel, overrides }
	}

	replace(snapshot: Partial<PluginLogPolicySnapshot>): void {
		const normalized = normalizeSnapshot(snapshot)
		this.defaultLevel = normalized.defaultLevel
		this.defaultRank = toRank(normalized.defaultLevel)
		this.overrides.clear()
		this.ranks.clear()
		for (const [pluginId, level] of Object.entries(normalized.overrides)) {
			this.overrides.set(pluginId, level)
			this.ranks.set(pluginId, toRank(level) ?? null)
		}
	}

	allows(record: LogRecord): boolean {
		const pluginId = recordPluginId(record)
		const rank = pluginId && this.ranks.has(pluginId) ? this.ranks.get(pluginId) : this.defaultRank
		if (rank === undefined) return true
		if (rank === null) return false
		return LEVEL_RANK[record.level] >= rank
	}

	setPluginLevel(pluginId: string, level: RuntimePluginLogLevel): void {
		const id = String(pluginId)
		if (!id) return
		const normalized = normalizeLevel(level)
		if (normalized === undefined) {
			this.clearPluginLevel(id)
			return
		}
		this.overrides.set(id, normalized)
		this.ranks.set(id, toRank(normalized) ?? null)
	}

	clearPluginLevel(pluginId: string): void {
		const id = String(pluginId)
		this.overrides.delete(id)
		this.ranks.delete(id)
	}

	setDefaultLevel(level: RuntimePluginLogLevel): void {
		const normalized = normalizeLevel(level)
		this.defaultLevel = normalized
		this.defaultRank = toRank(normalized)
	}

	clearDefaultLevel(): void {
		this.defaultLevel = undefined
		this.defaultRank = undefined
	}

	clear(): void {
		this.clearDefaultLevel()
		this.overrides.clear()
		this.ranks.clear()
	}

	lookupLogtapeLevel = (pluginId: string | undefined): LogLevel | null | undefined => {
		const override = pluginId === undefined ? undefined : this.overrides.get(pluginId)
		const level = override ?? this.defaultLevel
		if (level === undefined) return undefined
		if (level === 'off') return null
		return level
	}
}

export async function readPluginLogPolicyFile(
	path: string,
): Promise<PluginLogPolicySnapshot | null> {
	try {
		const raw = await readFile(path, 'utf8')
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
		return normalizeSnapshot(parsed as Partial<PluginLogPolicySnapshot>)
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ENOENT') return null
		throw error
	}
}

export async function writePluginLogPolicyFile(
	path: string,
	snapshot: PluginLogPolicySnapshot,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(normalizeSnapshot(snapshot), null, 2)}\n`)
}

export const runtimePluginLogPolicy = new RuntimePluginLogPolicy()
