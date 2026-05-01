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

function normalizeToolsets(items: readonly unknown[]): OpsToolsetInputValue[] {
	const byId = new Map<string, OpsToolsetInputValue>()
	for (const item of items) {
		const parsed = v.safeParse(OpsToolsetInputSchema, item)
		if (!parsed.success) continue
		const normalized = normalizeToolset(parsed.output)
		if (!normalized) continue
		byId.set(normalized.toolsetId, normalized)
	}
	return [...byId.values()]
}

export function readOpsToolsets(pCtx: PlxContext): OpsToolsetOutput[] {
	const raw = pCtx.configService.getExtra(OPS_TOOLSETS_KEY)
	if (!Array.isArray(raw)) return []

	return normalizeToolsets(raw).map(toOutput)
}

export function writeOpsToolsets(
	pCtx: PlxContext,
	toolsets: readonly unknown[],
): OpsToolsetOutput[] {
	const normalized = normalizeToolsets(toolsets)

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
				title: string
				description: string
			}
		}
		workbench: {
			mutating: boolean
			confirm: boolean
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
			title: entry.descriptor.doc.title,
			description: entry.descriptor.doc.description,
			tags: [],
			owner: entry.owner,
			ownerKind: entry.ownerKind,
			pluginId: entry.pluginId,
			mutating: entry.workbench.mutating,
			confirm: entry.workbench.confirm,
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
