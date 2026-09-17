import { formatPluginNodeReference, pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'

export type PluginNodeLabel = Readonly<{
	title: string
	qualifier?: string
	text: string
}>

export function buildPluginNodeLabels(
	entries: readonly Readonly<{ nodeAddress: PluginNodeAddress; displayName: string }>[],
): ReadonlyMap<string, PluginNodeLabel> {
	const projected = entries.map(({ nodeAddress, displayName }) => {
		const key = pluginNodeIndexKey(nodeAddress)
		const title = pluginNodeTitle(nodeAddress, displayName)
		const provenance = pluginNodeProvenance(nodeAddress)
		return {
			key,
			nodeAddress,
			title,
			provenance,
			exportName: escapePluginLabelPart(nodeAddress.definition.exportName),
			qualifier: undefined as string | undefined,
		}
	})
	const seenKeys = new Set<string>()
	for (const entry of projected) {
		if (seenKeys.has(entry.key)) {
			throw new Error(
				`Plugin catalog contains duplicate address: ${formatPluginNodeReference(entry.nodeAddress)}`,
			)
		}
		seenKeys.add(entry.key)
	}

	const titleCounts = countBy(projected, ({ title }) => title)
	for (const entry of projected) {
		entry.qualifier = titleCounts.get(entry.title) === 1 ? undefined : entry.provenance
	}
	const textCounts = countBy(projected, labelText)
	for (const entry of projected) {
		if (textCounts.get(labelText(entry)) !== 1 && entry.qualifier) {
			entry.qualifier = `${entry.provenance}::${entry.exportName}`
		}
	}
	const finalCounts = countBy(projected, labelText)

	return new Map(
		projected.map((entry) => {
			const duplicate = finalCounts.get(labelText(entry)) !== 1
			const qualifier = duplicate
				? escapePluginLabelPart(formatPluginNodeReference(entry.nodeAddress))
				: entry.qualifier
			return [
				entry.key,
				Object.freeze({
					title: entry.title,
					...(qualifier ? { qualifier } : {}),
					text: qualifier ? `${entry.title} (${qualifier})` : entry.title,
				}),
			]
		}),
	)
}

/** Deterministic fallback for records produced without an immutable catalog projection. */
export function formatPluginNodeStandaloneLabel(
	nodeAddress: PluginNodeAddress,
	displayName: string,
): string {
	return `${pluginNodeTitle(nodeAddress, displayName)} (${pluginNodeProvenance(nodeAddress)}::${escapePluginLabelPart(nodeAddress.definition.exportName)})`
}

function pluginNodeTitle(nodeAddress: PluginNodeAddress, displayName: string): string {
	const name = escapePluginLabelPart(displayName)
	return nodeAddress.variant === 'default'
		? name
		: `${name} / ${escapePluginLabelPart(nodeAddress.forkId)}`
}

function pluginNodeProvenance(nodeAddress: PluginNodeAddress): string {
	const entry = nodeAddress.definition.entry
	return entry.kind === 'package-root'
		? escapePluginLabelPart(entry.packageName)
		: `${escapePluginLabelPart(entry.sourceSpace)}:${escapePluginLabelPart(entry.path)}`
}

function labelText(entry: { title: string; qualifier?: string }): string {
	return entry.qualifier ? `${entry.title} (${entry.qualifier})` : entry.title
}

function countBy<T>(entries: readonly T[], keyOf: (entry: T) => string): Map<string, number> {
	const counts = new Map<string, number>()
	for (const entry of entries) {
		const key = keyOf(entry)
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	return counts
}

function escapePluginLabelPart(value: string): string {
	return value.replaceAll(/[\\()\p{Cc}]/gu, (character) => {
		if (character === '\\') return '\\\\'
		if (character === '(' || character === ')') return `\\${character}`
		return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
	})
}
