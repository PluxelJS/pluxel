import type { WorkspacePackageJson } from '../../workspace/package-json'
import type { RuleContext } from './types'

/** Generated publication fact consumed by production source admission. */
export function workbenchCapnwebRule(
	pkg: WorkspacePackageJson,
	context: RuleContext,
): string[] | undefined {
	const field = pkg.pluxel
	const manifest =
		field && typeof field === 'object' && !Array.isArray(field)
			? { ...(field as Record<string, unknown>) }
			: {}
	const messages: string[] = []
	for (const [key, next] of [
		['workbenchCapnweb', context.workbenchCapnwebVersion],
		['tinybase', context.tinybaseVersion],
	] as const) {
		if (manifest[key] === next) continue
		if (next) manifest[key] = next
		else delete manifest[key]
		messages.push(`pluxel.${key} ${next ? `set to ${next}` : 'removed'}`)
	}
	if (messages.length === 0) return undefined
	if (Object.keys(manifest).length > 0) pkg.pluxel = manifest
	else delete pkg.pluxel
	return messages
}
