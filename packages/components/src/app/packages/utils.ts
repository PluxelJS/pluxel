import type { PackageLoadIssue, PackageInventoryEntry, PluginStatusEntry } from '../gqty'
import type { PackageSpecInput } from '../rpc'
import type { Maybe, PackageRow } from './types'

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
})

export function formatTimestamp(value?: number | null) {
	if (!value || Number.isNaN(value)) return '未知时间'
	try {
		return timeFormatter.format(new Date(value))
	} catch {
		return new Date(value).toLocaleString()
	}
}

function ensureRow(map: Map<string, PackageRow>, name: string, raw?: string | null) {
	let row = map.get(name)
	if (!row) {
		row = {
			name,
			version: null,
			tag: null,
			raw: raw ?? null,
			installedVersion: null,
			requestedVersion: null,
			loaded: false,
			pluginCount: 0,
			runningCount: 0,
			pluginNames: [],
			issues: [],
		}
		map.set(name, row)
	} else if (raw && !row.raw) {
		row.raw = raw
	}
	return row
}

export function buildPackageRows(
	statuses: Array<Maybe<PluginStatusEntry>>,
	issues: Array<Maybe<PackageLoadIssue>>,
	inventory: Array<Maybe<PackageInventoryEntry>>,
): PackageRow[] {
	const map = new Map<string, PackageRow>()

	for (const entry of inventory ?? []) {
		const spec = entry?.spec
		if (!spec?.name) continue
		const row = ensureRow(map, spec.name, spec.raw ?? spec.name)
		if (spec.version && !row.version) row.version = spec.version
		if (spec.tag && !row.tag) row.tag = spec.tag
		if (!row.raw && spec.raw) row.raw = spec.raw
		if (entry?.installedVersion && !row.installedVersion) {
			row.installedVersion = entry.installedVersion
		}
		if (entry?.requestedVersion && !row.requestedVersion) {
			row.requestedVersion = entry.requestedVersion
		}
		if (entry?.loaded) row.loaded = true
		if (entry?.issues?.length) {
			entry.issues.forEach((issue) => {
				if (issue && !row.issues.includes(issue as any)) {
					row.issues.push(issue as PackageLoadIssue)
				}
			})
		}
	}

	for (const entry of statuses ?? []) {
		const source = entry?.source
		if (!source || source.kind !== 'package') continue
		const pkgName = source.packageName || ''
		if (!pkgName) continue
		const row = ensureRow(map, pkgName, source.packageName)
		if (source.version && !row.version) row.version = source.version
		if (source.tag && !row.tag) row.tag = source.tag
		row.loaded = true
		if (entry?.isRunning) row.runningCount += 1
		row.pluginCount += 1
		const pluginName = entry?.name
		if (pluginName && !row.pluginNames.includes(pluginName)) {
			row.pluginNames.push(pluginName)
		}
	}

	for (const issue of issues ?? []) {
		const spec = issue?.spec
		if (!spec?.name) continue
		const row = ensureRow(map, spec.name, spec.raw ?? spec.name)
		if (!row.version && spec.version) row.version = spec.version
		if (!row.tag && spec.tag) row.tag = spec.tag
		if (!row.raw && spec.raw) row.raw = spec.raw
		row.issues.push(issue)
	}

	return Array.from(map.values()).sort((a, b) =>
		a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' }),
	)
}

export function toSpecInput(row: PackageRow): PackageSpecInput {
	if (row.version || row.installedVersion) {
		return { name: row.name, version: row.version ?? row.installedVersion ?? undefined }
	}
	if (row.tag) {
		return { name: row.name, tag: row.tag }
	}
	if (row.raw) {
		return { raw: row.raw }
	}
	return { name: row.name }
}

export function formatSpec(row: PackageRow) {
	if (row.installedVersion && row.version && row.installedVersion !== row.version) {
		return `v${row.installedVersion} (请求 ${row.version})`
	}
	if (row.installedVersion) return `v${row.installedVersion}`
	if (row.version) return `v${row.version}`
	if (row.tag) return `tag: ${row.tag}`
	return 'latest'
}

const INSTALL_DELIMITER = /[\n,;]+/

export function parseInstallSpecs(input: string): string[] {
	return input
		.split(INSTALL_DELIMITER)
		.map((item) => item.trim())
		.filter((item, index, array) => item.length > 0 && array.indexOf(item) === index)
}

export function summarizeList(
	items: string[],
	peekCount: number,
	suffix: string,
	delimiter = '、',
) {
	if (!items.length) return ''
	if (items.length <= peekCount) {
		return items.join(delimiter)
	}
	return `${items.slice(0, peekCount).join(delimiter)} 等 ${items.length}${suffix}`
}

export function buildInstalledPackages(statuses: Array<any> | undefined) {
	const result: Record<string, string> = {}
	if (!statuses) return result
	for (const entry of statuses) {
		const source = entry?.source
		if (!source) continue
		if (source.kind !== 'package') continue
		const name = source.packageName || entry?.name
		if (!name) continue
		result[name] = source.version || ''
	}
	return result
}

export const parseDependencySpec = (spec: string) => {
	const trimmed = spec.trim()
	const match = trimmed.match(/^(@[^/@]+\/[^@]+|[^@]+)(?:@(.+))?$/)
	return {
		name: match?.[1] ?? trimmed,
		version: match?.[2],
		raw: trimmed,
	}
}

export const getPackageNameFromSpec = (spec: string) => {
	const parsed = parseDependencySpec(spec)
	return parsed.name
}
