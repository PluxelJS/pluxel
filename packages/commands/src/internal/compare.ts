/** Locale-independent ordering for stable catalogs, snapshots, and generated docs. */
export function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
