import type { Context } from '@pluxel/core'
import type { McpServer } from 'mcp-lite'
import * as v from 'valibot'
import { getDevRuntimeHandles } from '../../runtime/dev-handles'
import { logsLatest, logsWaitFor } from '../usecases/logs'
import { logsLatestText, logsWaitForText } from '../usecases/logsLlm'
import { workspaceListEntries, workspaceResolveEntry } from '../usecases/workspace'
import { textResult } from './shared'

type HmrBatchSummaryLike = {
	epoch: number
	ok: boolean
	lifecycleOk?: boolean
	changed: readonly string[]
	targets: readonly string[]
	affected: number
	fallbackRoots: number
	invalidated: { vite: number; runner: number }
	commitMs: number | null
	batchMs: number
	commitError?: string
	commit?: {
		added: readonly string[]
		replaced: readonly string[]
		removed: readonly string[]
		failed: readonly string[]
		touched: readonly string[]
	}
}

const UiLogRecordSchema = v.object({
	streamId: v.string(),
	epoch: v.number(),
	seq: v.string(),
	ts: v.number(),
	level: v.string(),
	category: v.array(v.string()),
	msg: v.string(),
	message: v.optional(v.array(v.unknown())),
	name: v.optional(v.string()),
	pluginId: v.optional(v.string()),
	context: v.optional(v.string()),
	props: v.optional(v.record(v.string(), v.unknown())),
	error: v.optional(v.record(v.string(), v.unknown())),
	raw: v.optional(v.unknown()),
})

const LogFilterSchema = v.optional(
	v.object({
		name: v.optional(v.string()),
		pluginId: v.optional(v.string()),
		context: v.optional(v.string()),
		displayName: v.optional(v.string()),
		category: v.optional(v.string()),
	}),
)

const LogsLatestInputSchema = v.object({
	streamId: v.optional(v.string()),
	limit: v.optional(v.number()),
	afterSeq: v.optional(v.string()),
	filter: LogFilterSchema,
})

const LogsLatestOutputSchema = v.object({
	meta: v.object({
		streamId: v.string(),
		bootId: v.string(),
		epoch: v.number(),
		headSeq: v.string(),
		tailSeq: v.string(),
		nextSeq: v.string(),
		count: v.number(),
		retention: v.object({
			windowLines: v.number(),
		}),
	}),
	lines: v.array(UiLogRecordSchema),
})

const LogsTextFormatSchema = v.optional(
	v.object({
		maxChars: v.optional(v.number()),
		maxLineChars: v.optional(v.number()),
		maxStackLines: v.optional(v.number()),
		includeCategory: v.optional(v.boolean()),
		includeOrigin: v.optional(v.boolean()),
		includeProps: v.optional(v.boolean()),
	}),
)

const LogsWaitForInputSchema = v.object({
	streamId: v.optional(v.string()),
	limit: v.optional(v.number()),
	afterSeq: v.optional(v.string()),
	timeoutMs: v.optional(v.number()),
	filter: LogFilterSchema,
})

const LogsLatestTextInputSchema = v.object({
	streamId: v.optional(v.string()),
	limit: v.optional(v.number()),
	afterSeq: v.optional(v.string()),
	filter: LogFilterSchema,
	format: LogsTextFormatSchema,
})

const LogsWaitForTextInputSchema = v.object({
	streamId: v.optional(v.string()),
	limit: v.optional(v.number()),
	afterSeq: v.optional(v.string()),
	timeoutMs: v.optional(v.number()),
	filter: LogFilterSchema,
	format: LogsTextFormatSchema,
})

const LogsTextOutputSchema = v.object({
	text: v.string(),
	streamId: v.string(),
	bootId: v.string(),
	epoch: v.number(),
	tailSeq: v.string(),
	count: v.number(),
	truncated: v.boolean(),
})

const WaitForBatchInputSchema = v.object({
	afterEpoch: v.optional(v.number()),
	timeoutMs: v.optional(v.number()),
})

const WaitForStableInputSchema = v.object({
	afterEpoch: v.optional(v.number()),
	timeoutMs: v.optional(v.number()),
	quietMs: v.optional(v.number()),
})

const WaitForBatchOutputSchema = v.object({
	epoch: v.number(),
	ok: v.boolean(),
	lifecycleOk: v.optional(v.boolean()),
	changed: v.array(v.string()),
	targets: v.array(v.string()),
	affected: v.number(),
	fallbackRoots: v.number(),
	invalidated: v.object({ vite: v.number(), runner: v.number() }),
	commitMs: v.nullable(v.number()),
	batchMs: v.number(),
	commitError: v.optional(v.string()),
	commit: v.optional(
		v.object({
			added: v.array(v.string()),
			replaced: v.array(v.string()),
			removed: v.array(v.string()),
			failed: v.array(v.string()),
			touched: v.array(v.string()),
		}),
	),
})

const EntryResolutionOkSchema = v.object({
	ok: v.literal(true),
	dir: v.string(),
	entry: v.string(),
	source: v.string(),
	tried: v.array(v.string()),
})

const EntryResolutionErrSchema = v.object({
	ok: v.literal(false),
	dir: v.string(),
	code: v.string(),
	message: v.string(),
	tried: v.optional(v.array(v.string())),
})

const EntryResolutionSchema = v.union([EntryResolutionOkSchema, EntryResolutionErrSchema])

const WorkspaceResolveEntryInputSchema = v.object({
	name: v.string(),
	workspaceOnly: v.optional(v.boolean()),
	preferHmrExports: v.optional(v.boolean()),
	conditions: v.optional(v.array(v.string())),
})

const WorkspaceListEntriesOutputSchema = v.array(v.object({ dir: v.string(), entry: v.string() }))

const HmrLastBatchOutputSchema = v.object({ batch: v.nullable(WaitForBatchOutputSchema) })

const HmrExecuteFilesInputSchema = v.object({
	files: v.array(v.string()),
	keepOrder: v.optional(v.boolean()),
})

const HmrExecuteFilesOutputSchema = v.object({ ok: v.literal(true) })

export function registerRuntimeDevTools(server: McpServer, ctx: Context) {
	const requireHmr = () => {
		const handles = getDevRuntimeHandles(ctx)
		const hmr = handles?.hmr
		if (hmr) return hmr

		throw new Error('HMR runtime not available (did you start the Vite dev runtime?)')
	}

	const toBatchPublic = (summary: HmrBatchSummaryLike) => ({
		epoch: summary.epoch,
		ok: summary.ok,
		...(typeof summary.lifecycleOk === 'boolean' ? { lifecycleOk: summary.lifecycleOk } : {}),
		changed: [...summary.changed],
		targets: [...summary.targets],
		affected: summary.affected,
		fallbackRoots: summary.fallbackRoots,
		invalidated: summary.invalidated,
		commitMs: summary.commitMs,
		batchMs: summary.batchMs,
		...(summary.commitError ? { commitError: summary.commitError } : {}),
		...(summary.commit ? { commit: summary.commit } : {}),
	})

	server.tool('hmr.waitForBatch', {
		description: 'Wait for the next completed HMR batch and return its summary.',
		inputSchema: WaitForBatchInputSchema,
		outputSchema: WaitForBatchOutputSchema,
		handler: async (args) => {
			const hmr = requireHmr()
			const summary = (await hmr.api.waitForBatch({
				afterEpoch: args.afterEpoch,
				timeoutMs: args.timeoutMs,
			})) as HmrBatchSummaryLike
			const out = toBatchPublic(summary)
			return textResult(`HMR batch #${out.epoch} ${out.ok ? 'ok' : 'failed'}`, out)
		},
	})

	server.tool('hmr.waitForStable', {
		description:
			'Wait for HMR batches until a quiet period elapses (stable state), then return the most recent batch summary.',
		inputSchema: WaitForStableInputSchema,
		outputSchema: WaitForBatchOutputSchema,
		handler: async (args) => {
			const hmr = requireHmr()
			const summary = (await hmr.api.waitForStable({
				afterEpoch: args.afterEpoch,
				timeoutMs: args.timeoutMs,
				quietMs: args.quietMs,
			})) as HmrBatchSummaryLike
			const out = toBatchPublic(summary)
			return textResult(`HMR stable at #${out.epoch} ${out.ok ? 'ok' : 'failed'}`, out)
		},
	})

	server.tool('logs.latest', {
		description: 'Read recent UI logs from the in-memory log store.',
		inputSchema: LogsLatestInputSchema,
		outputSchema: LogsLatestOutputSchema,
		handler: (args) => {
			const afterSeq =
				typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
			const out = logsLatest({
				streamId: args.streamId,
				limit: args.limit,
				afterSeq,
				filter: args.filter,
			})
			return textResult(`logs: ${out.lines.length} lines (tailSeq=${out.meta.tailSeq})`, out)
		},
	})

	server.tool('logs.latestText', {
		description:
			'Read recent logs formatted as compact text for LLMs (stable fields, truncation, noise reduction).',
		inputSchema: LogsLatestTextInputSchema,
		outputSchema: LogsTextOutputSchema,
		handler: (args) => {
			const afterSeq =
				typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
			const out = logsLatestText({
				streamId: args.streamId,
				limit: args.limit,
				afterSeq,
				filter: args.filter,
				format: args.format,
			})
			return textResult(out.text, out)
		},
	})

	server.tool('logs.waitFor', {
		description:
			'Wait until at least one log matching the filter arrives (or timeout). Designed for MCP clients to implement tail/follow loops.',
		inputSchema: LogsWaitForInputSchema,
		outputSchema: LogsLatestOutputSchema,
		handler: async (args) => {
			const afterSeq =
				typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
			const out = await logsWaitFor({
				streamId: args.streamId,
				limit: args.limit,
				afterSeq,
				timeoutMs: args.timeoutMs,
				filter: args.filter,
			})
			return textResult(`logs: ${out.lines.length} lines (tailSeq=${out.meta.tailSeq})`, out)
		},
	})

	server.tool('logs.waitForText', {
		description:
			'Wait for new logs, then return an LLM-friendly compact text snapshot (recommended for agents).',
		inputSchema: LogsWaitForTextInputSchema,
		outputSchema: LogsTextOutputSchema,
		handler: async (args) => {
			const afterSeq =
				typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
			const out = await logsWaitForText({
				streamId: args.streamId,
				limit: args.limit,
				afterSeq,
				timeoutMs: args.timeoutMs,
				filter: args.filter,
				format: args.format,
			})
			return textResult(out.text, out)
		},
	})

	server.tool('workspace.resolveEntry', {
		description: 'Resolve a workspace package entry (prefer @pluxel/runtime export by default).',
		inputSchema: WorkspaceResolveEntryInputSchema,
		outputSchema: EntryResolutionSchema,
		handler: async (args) => {
			const out = await workspaceResolveEntry(ctx, args)
			const msg = out.ok === true ? out.entry : out.message
			return textResult(msg, out)
		},
	})

	server.tool('workspace.listEntries', {
		description: 'List workspace packages that have a resolvable entry.',
		inputSchema: v.object({}),
		outputSchema: WorkspaceListEntriesOutputSchema,
		handler: async () => {
			const out = await workspaceListEntries(ctx)
			return textResult(`entries: ${out.length}`, out)
		},
	})

	server.tool('hmr.lastBatch', {
		description: 'Get the last completed HMR batch summary (or null).',
		inputSchema: v.object({}),
		outputSchema: HmrLastBatchOutputSchema,
		handler: () => {
			const raw = requireHmr().api.lastBatch() as HmrBatchSummaryLike | null
			const batch = raw ? toBatchPublic(raw) : null
			return textResult(batch ? `batch #${batch.epoch}` : 'no batch yet', { batch })
		},
	})

	server.tool('hmr.executeFiles', {
		description:
			'Force-evaluate and load a list of files using the HMR pipeline (commit included).',
		inputSchema: HmrExecuteFilesInputSchema,
		outputSchema: HmrExecuteFilesOutputSchema,
		handler: async (args) => {
			const hmr = requireHmr()
			if (!hmr.executeFiles) throw new Error('hmr.executeFiles not available')
			await hmr.executeFiles(args.files, args.keepOrder !== false)
			return textResult('ok', { ok: true as const })
		},
	})
}
