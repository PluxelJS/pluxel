// union/unionExtractor.ts
import { META_MAP, collectObjectEntries, type Schema } from '~/core/utils'
import type { UnionMetaOptions, UnionMetaResult, UnionSelectorVariant } from './type'

type UnionSchema = Schema & { type: 'union'; options: readonly Schema[]; pipe?: readonly unknown[] }
type VariantSchema = Schema & {
	type: 'variant'
	key: string
	options: readonly Schema[]
	pipe?: readonly unknown[]
}
type IntersectSchema = Schema & {
	type: 'intersect'
	options: readonly Schema[]
	pipe?: readonly unknown[]
}

type DiscriminatorValue = string | number | boolean | null

const BOOLEANISH = new Set<unknown>([true, false, 'true', 'false', 1, 0, '1', '0'])

const isDevEnv = () => {
	if (typeof process === 'undefined') return true
	return process.env?.NODE_ENV !== 'production'
}

const isSchema = (value: unknown): value is Schema =>
	Boolean(value) && typeof value === 'object' && (value as { kind?: string }).kind === 'schema'

function readUnionMetadata(schema: Schema): UnionMetaOptions {
	const meta: Partial<UnionMetaOptions> = {}
	const pipe = (schema as any).pipe
	if (pipe) {
		for (let i = pipe.length - 1; i >= 0; i--) {
			const item = pipe[i] as { kind?: string; type?: string; metadata?: Partial<UnionMetaOptions> }
			if (item?.kind === 'metadata' && item.type === META_MAP.union) {
				Object.assign(meta, item.metadata)
				break
			}
		}
	}

	return {
		variant: 'auto',
		exposeDiscriminator: 'auto',
		preserveBranchValues: true,
		...meta,
	}
}

function literalLikeValue(schema: Schema): DiscriminatorValue | undefined {
	if (schema.type === 'literal') {
		const literalSchema = schema as Schema & { type: 'literal'; literal: unknown }
		return (literalSchema.literal as DiscriminatorValue) ?? null
	}

	if (schema.type === 'picklist') {
		const picklist = schema as Schema & { options?: readonly (string | number)[] }
		if (picklist.options?.length === 1) {
			return (picklist.options[0] as DiscriminatorValue) ?? null
		}
	}

	return undefined
}

function entriesToMap(schema: Schema): Map<string, Schema> | undefined {
	const entries = collectObjectEntries(schema)
	if (!entries) return undefined
	const map = new Map<string, Schema>()
	for (const entry of entries) {
		map.set(entry.name, entry.schema)
	}
	return map
}

function inferDiscriminatorKey(branches: readonly Schema[]): string | undefined {
	const entryMaps = branches
		.map((branch) => entriesToMap(branch))
		.filter((item): item is Map<string, Schema> => Boolean(item))
	if (!entryMaps.length) return undefined

	const candidate = new Map<string, DiscriminatorValue[]>()
	for (const map of entryMaps) {
		for (const [name, schema] of map.entries()) {
			const value = literalLikeValue(schema)
			if (value === undefined) continue
			const bucket = candidate.get(name) ?? []
			bucket.push(value)
			candidate.set(name, bucket)
		}
	}

	const requiredCount = entryMaps.length
	const validCandidates = Array.from(candidate.entries()).filter(([_, values]) => {
		if (values.length !== requiredCount) return false
		return new Set(values.map((v) => `${v}`)).size === requiredCount
	})
	if (!validCandidates.length) return undefined

	const booleanCandidate = validCandidates.find(([_, values]) =>
		values.every((v) => BOOLEANISH.has(v)),
	)
	if (booleanCandidate) return booleanCandidate[0]

	const priority = ['type', 'kind', 'mode', 'enabled']
	for (const key of priority) {
		if (validCandidates.some(([candidateKey]) => candidateKey === key)) return key
	}

	validCandidates.sort(([a], [b]) => a.localeCompare(b))
	return validCandidates[0][0]
}

function extractDiscriminatorValueFromBranch(
	branchSchema: Schema,
	discriminatorKey?: string,
): DiscriminatorValue | undefined {
	if (!discriminatorKey) return undefined
	const entryMap = entriesToMap(branchSchema)
	const discriminatorSchema = entryMap?.get(discriminatorKey)
	if (!discriminatorSchema) return undefined
	return literalLikeValue(discriminatorSchema)
}

function findEntrySchema(branchSchema: Schema, key: string): Schema | undefined {
	const entryMap = entriesToMap(branchSchema)
	return entryMap?.get(key)
}

function gatherUnionParts(schema: UnionSchema | VariantSchema | IntersectSchema) {
	if (schema.type !== 'intersect') {
		return {
			unionSchema:
				schema.type === 'union' || schema.type === 'variant'
					? (schema as UnionSchema | VariantSchema)
					: undefined,
			sharedObjects: [] as Schema[],
			mode: schema.type,
		}
	}

	const sharedObjects: Schema[] = []
	let unionSchema: UnionSchema | VariantSchema | undefined

	const walk = (node: IntersectSchema) => {
		for (const option of node.options ?? []) {
			if (!isSchema(option)) continue
			if (!unionSchema && (option.type === 'union' || option.type === 'variant')) {
				unionSchema = option as UnionSchema | VariantSchema
				continue
			}
			if (option.type === 'intersect') {
				walk(option as IntersectSchema)
				continue
			}
			if (option.type === 'object') {
				sharedObjects.push(option)
			}
		}
	}

	walk(schema as IntersectSchema)

	return { unionSchema, sharedObjects, mode: 'intersect' as const }
}

function gatherSharedFields(sharedObjects: Schema[], discriminatorKey?: string) {
	const fieldMap = new Map<string, Schema>()
	let discriminatorSchema: Schema | undefined

	for (const shared of sharedObjects) {
		const entries = collectObjectEntries(shared)
		if (!entries) continue
		for (const entry of entries) {
			if (entry.name === discriminatorKey) {
				discriminatorSchema ??= entry.schema
				continue
			}
			if (fieldMap.has(entry.name) && isDevEnv()) {
				console.warn(
					`[valibot-form] Intersect contains duplicate key "${entry.name}". The latter definition overrides the former.`,
				)
			}
			fieldMap.set(entry.name, entry.schema)
		}
	}

	return {
		sharedFields: Array.from(fieldMap.entries()).map(([key, schema]) => ({ key, schema })),
		discriminatorSchema,
	}
}

function isBooleanish(values: Array<DiscriminatorValue | undefined>) {
	const present = values.filter((v) => v !== undefined && v !== null)
	if (!present.length) return false
	return present.every((v) => BOOLEANISH.has(v as unknown))
}

function resolveVariant(
	requested: UnionSelectorVariant | undefined,
	branches: Array<{ discriminatorValue: DiscriminatorValue }>,
	discriminatorSchema?: Schema,
): Exclude<UnionSelectorVariant, 'auto'> {
	if (requested && requested !== 'auto') return requested

	if (!branches.length) return 'select'

	const values = branches.map((b) => b.discriminatorValue)
	if (discriminatorSchema?.type === 'boolean' || isBooleanish(values)) {
		return 'switch'
	}

	if (branches.length <= 3) return 'segmented'
	if (branches.length <= 5) return 'radio'
	return 'select'
}

/**
 * 提取 Union/Variant 的配置与分支信息，涵盖 intersect 包裹的场景。
 */
export function extractUnionProps(
	schema: UnionSchema | VariantSchema | IntersectSchema,
): UnionMetaResult {
	const metadata = readUnionMetadata(schema)
	const { unionSchema, sharedObjects } = gatherUnionParts(schema)

	if (!unionSchema) {
		if (isDevEnv()) {
			console.warn(
				'[valibot-form] unionMeta() 需要作用在 union/variant schema 上才能提取表单信息。',
			)
		}
		const fallbackVariant =
			metadata.variant && metadata.variant !== 'auto' ? metadata.variant : ('select' as const)
		return {
			...metadata,
			discriminator: metadata.discriminator,
			branches: [],
			sharedFields: [],
			discriminatorSchema: undefined,
			discriminatorSource: 'none',
			resolvedVariant: fallbackVariant,
		}
	}

	let discriminator = metadata.discriminator
	if (!discriminator && unionSchema.type === 'variant') {
		discriminator = (unionSchema as VariantSchema).key
	}

	if (!discriminator) {
		discriminator = inferDiscriminatorKey(unionSchema.options)
	}

	const { sharedFields, discriminatorSchema: sharedDiscriminatorSchema } = gatherSharedFields(
		sharedObjects,
		discriminator,
	)

	const branches = unionSchema.options.map((branchSchema) => {
		const discriminatorValue =
			extractDiscriminatorValueFromBranch(branchSchema, discriminator) ?? null
		return {
			discriminatorValue,
			schema: branchSchema,
		}
	})

	const labelKeys = metadata.branchLabels ? Object.keys(metadata.branchLabels) : []
	for (let i = 0; i < branches.length; i++) {
		if (branches[i].discriminatorValue === null || branches[i].discriminatorValue === undefined) {
			if (labelKeys.length === branches.length) {
				branches[i].discriminatorValue = labelKeys[i] as DiscriminatorValue
			} else if (branches.length === 2 && discriminator) {
				branches[i].discriminatorValue = (i === 0 ? false : true) as DiscriminatorValue
			} else {
				branches[i].discriminatorValue = i as DiscriminatorValue
			}
		}
	}

	let discriminatorSchema: Schema | undefined = sharedDiscriminatorSchema
	if (!discriminatorSchema && discriminator) {
		discriminatorSchema = findEntrySchema(unionSchema.options[0], discriminator)
	}

	const discriminatorSource: UnionMetaResult['discriminatorSource'] = discriminator
		? sharedDiscriminatorSchema
			? 'shared'
			: metadata.discriminator || unionSchema.type === 'variant'
				? 'branch'
				: 'inferred'
		: 'none'

	const resolvedVariant = resolveVariant(metadata.variant, branches, discriminatorSchema)

	return {
		...metadata,
		discriminator,
		branches,
		sharedFields,
		discriminatorSchema,
		discriminatorSource,
		resolvedVariant,
	}
}
