export type PackageSpecifierInput =
	| string
	| {
			name?: string | null
			version?: string | null
			tag?: string | null
	  }

export interface NormalizedPackageSpecifier {
	name: string
	version?: string
	tag?: string
	raw: string
	target: string
	key: string
}

export function normalizeSpecifier(input: PackageSpecifierInput): NormalizedPackageSpecifier {
	const normalized =
		typeof input === 'string' ? parseStringSpecifier(input) : parseObjectSpecifier(input)
	if (!normalized) {
		throw new Error('Package specifier is empty.')
	}
	return withDerivedFields(normalized)
}

export function tryNormalizeSpecifier(
	input: PackageSpecifierInput,
): NormalizedPackageSpecifier | undefined {
	const normalized =
		typeof input === 'string' ? parseStringSpecifier(input) : parseObjectSpecifier(input)
	return normalized ? withDerivedFields(normalized) : undefined
}

export function withVersion(
	spec: NormalizedPackageSpecifier,
	version: string,
): NormalizedPackageSpecifier {
	const trimmed = version.trim()
	if (!trimmed) {
		throw new Error('Version cannot be empty.')
	}
	return withDerivedFields({
		name: spec.name,
		version: trimmed,
		raw: `${spec.name}@${trimmed}`,
	})
}

export function withTag(spec: NormalizedPackageSpecifier, tag: string): NormalizedPackageSpecifier {
	const trimmed = tag.trim()
	if (!trimmed) {
		throw new Error('Tag cannot be empty.')
	}
	return withDerivedFields({
		name: spec.name,
		tag: trimmed,
		raw: `${spec.name}@${trimmed}`,
	})
}

function parseStringSpecifier(rawInput: string): Omit<NormalizedPackageSpecifier, 'target' | 'key'> | undefined {
	const raw = rawInput.trim()
	if (!raw) return undefined

	if (raw.startsWith('@')) {
		const secondAt = raw.indexOf('@', 1)
		if (secondAt === -1) {
			return { name: raw, version: undefined, raw }
		}
		const name = raw.slice(0, secondAt)
		const suffix = raw.slice(secondAt + 1)
		return {
			name,
			version: suffix || undefined,
			raw,
		}
	}

	const parts = raw.split('@')
	if (parts.length === 1) {
		return {
			name: parts[0],
			version: undefined,
			raw,
		}
	}

	const version = parts.pop() || undefined
	const name = parts.join('@')
	return {
		name,
		version: version && version.length > 0 ? version : undefined,
		raw,
	}
}

function parseObjectSpecifier(
	input: { name?: string | null; version?: string | null; tag?: string | null },
): Omit<NormalizedPackageSpecifier, 'target' | 'key'> | undefined {
	const name = input.name?.trim()
	if (!name) return undefined
	const version = input.version?.toString().trim() || undefined
	const tag = version ? undefined : input.tag?.toString().trim() || undefined
	const raw = version
		? `${name}@${version}`
		: tag
			? `${name}@${tag}`
			: name
	return {
		name,
		version,
		tag,
		raw,
	}
}

function withDerivedFields(
	base: Omit<NormalizedPackageSpecifier, 'target' | 'key'>,
): NormalizedPackageSpecifier {
	const version = base.version?.trim() || undefined
	const tag = version ? undefined : base.tag?.trim() || undefined
	const name = base.name.trim()
	if (!name) {
		throw new Error('Package name is empty.')
	}

	const target = version ? `${name}@${version}` : tag ? `${name}@${tag}` : name
	const identity = version ?? (tag ? `tag:${tag}` : 'latest')
	return {
		name,
		version,
		tag,
		raw: base.raw,
		target,
		key: `${name}#${identity}`,
	}
}
