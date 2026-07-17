import type { PermissionEffect, PermissionGrant } from './model.ts'

export function normalizePermissionNode(node: string): string {
	const value = node.trim().toLowerCase()
	if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\.\*)?$/.test(value))
		throw new Error(`Invalid permission node: ${node}`)
	return value
}

/** Exact first, then longest wildcard prefix. */
export function decideGrants(
	grants: readonly PermissionGrant[],
	node: string,
): PermissionEffect | undefined {
	let best: PermissionGrant | undefined
	for (const grant of grants) {
		if (grant.node === node) return grant.effect
		if (!grant.node.endsWith('.*')) continue
		const prefix = grant.node.slice(0, -1)
		if (node.startsWith(prefix) && (!best || grant.node.length > best.node.length)) best = grant
	}
	return best?.effect
}
