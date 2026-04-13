import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import type { OpsToolset, OpsToolsetInput, RuntimeOpToolsetManifest } from '../../web/protocol'

const OPS_TOOLSETS_KEY = 'opsToolsets'

export const OpsToolsetInputSchema = v.object({
	toolsetId: v.string(),
	name: v.string(),
	description: v.optional(v.string()),
	opIds: v.array(v.string()),
})

export const OpsToolsetSchema = v.object({
	__typename: v.literal('OpsToolset'),
	toolsetId: v.string(),
	name: v.string(),
	description: v.optional(v.string()),
	opIds: v.array(v.string()),
})

export type OpsToolsetInputValue = v.InferInput<typeof OpsToolsetInputSchema>
export type OpsToolsetOutput = v.InferOutput<typeof OpsToolsetSchema>

function unique(values: string[]): string[] {
	return Array.from(new Set(values))
}

function normalizeToolset(toolset: OpsToolsetInputValue): OpsToolsetInputValue | null {
	const toolsetId = String(toolset.toolsetId ?? '').trim()
	const name = String(toolset.name ?? '').trim()
	const description = typeof toolset.description === 'string' ? toolset.description.trim() : undefined
	if (!toolsetId || !name) return null

	return {
		toolsetId,
		name,
		description: description || undefined,
		opIds: unique(toolset.opIds.map((value) => String(value).trim()).filter(Boolean)),
	}
}

function toOutput(toolset: OpsToolsetInputValue): OpsToolsetOutput {
	return {
		__typename: 'OpsToolset',
		toolsetId: toolset.toolsetId,
		name: toolset.name,
		description: toolset.description,
		opIds: toolset.opIds,
	}
}

export function readOpsToolsets(pCtx: PlxContext): OpsToolsetOutput[] {
	const raw = pCtx.configService.getExtra(OPS_TOOLSETS_KEY)
	if (!Array.isArray(raw)) return []

	const toolsets: OpsToolsetOutput[] = []
	for (const item of raw) {
		const parsed = v.safeParse(OpsToolsetInputSchema, item)
		if (!parsed.success) continue
		const normalized = normalizeToolset(parsed.output)
		if (!normalized) continue
		toolsets.push(toOutput(normalized))
	}
	return toolsets
}

export function writeOpsToolsets(
	pCtx: PlxContext,
	toolsets: OpsToolsetInputValue[],
): OpsToolsetOutput[] {
	const normalized = toolsets
		.map(normalizeToolset)
		.filter((toolset): toolset is OpsToolsetInputValue => toolset !== null)

	pCtx.configService.setExtra(
		OPS_TOOLSETS_KEY,
		normalized.map((toolset) => ({
			toolsetId: toolset.toolsetId,
			name: toolset.name,
			description: toolset.description,
			opIds: toolset.opIds,
		})),
	)

	return normalized.map(toOutput)
}

export function buildOpsToolsetManifest(options: {
	toolset: OpsToolset
	entries: Array<{
		id: string
		owner: string
		ownerKind: RuntimeOpToolsetManifest['tools'][number]['ownerKind']
		pluginId?: string
		descriptor: {
			doc: {
				title?: string
				description?: string
				tags?: string[]
			}
			policy: {
				mutating?: boolean
				confirm?: boolean
			}
		}
	}>
}): RuntimeOpToolsetManifest {
	const byId = new Map(options.entries.map((entry) => [entry.id, entry]))
	const tools: RuntimeOpToolsetManifest['tools'] = []
	const missingOpIds: string[] = []

	for (const opId of options.toolset.opIds) {
		const entry = byId.get(opId)
		if (!entry) {
			missingOpIds.push(opId)
			continue
		}
		tools.push({
			id: entry.id,
			title: entry.descriptor.doc.title ?? entry.id,
			description: entry.descriptor.doc.description,
			tags: entry.descriptor.doc.tags ?? [],
			owner: entry.owner,
			ownerKind: entry.ownerKind,
			pluginId: entry.pluginId,
			mutating: entry.descriptor.policy.mutating === true,
			confirm: entry.descriptor.policy.confirm === true,
		})
	}

	return {
		toolset: options.toolset,
		tools,
		missingOpIds,
	}
}

export type {
	OpsToolset,
	OpsToolsetInput,
	RuntimeOpToolsetManifest,
}
