import { compare, valid } from 'semver'

export function versionRelation(installed: string | null, version: string) {
	if (!installed) return undefined
	if (installed === version) return 'installed'
	if (!valid(installed) || !valid(version)) return 'different'
	const order = compare(version, installed)
	return order > 0 ? 'newer' : order < 0 ? 'older' : 'different'
}
