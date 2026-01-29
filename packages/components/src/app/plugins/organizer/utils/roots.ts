export function deriveRootLabel(moduleId: string | null | undefined, statusName: string) {
	if (!moduleId) return '本地插件'
	const normalized = moduleId.replace(/\\/g, '/')
	const parts = normalized.split('/').filter(Boolean)
	if (parts.length === 0) return '本地插件'
	const last = parts[parts.length - 1] ?? ''
	if (/\.[a-z0-9]+$/i.test(last)) parts.pop()
	const skip = new Set(['src', 'lib', 'dist', 'build'])
	let candidate = parts[parts.length - 1] ?? ''
	while (candidate && skip.has(candidate) && parts.length > 1) {
		parts.pop()
		candidate = parts[parts.length - 1] ?? ''
	}
	const normalizedCandidate = candidate.toLowerCase()
	const normalizedName = statusName.toLowerCase()
	if (normalizedCandidate === normalizedName && parts.length > 1) {
		parts.pop()
		candidate = parts[parts.length - 1] ?? candidate
		while (candidate && skip.has(candidate) && parts.length > 1) {
			parts.pop()
			candidate = parts[parts.length - 1] ?? candidate
		}
	}
	return candidate || '本地插件'
}
