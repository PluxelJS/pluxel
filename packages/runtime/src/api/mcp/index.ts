import type { Context } from '@pluxel/core'
import { toJsonSchema } from '@valibot/to-json-schema'
import {
	InMemorySessionAdapter,
	McpServer,
	StreamableHttpTransport,
	type ToolCallResult,
} from 'mcp-lite'
import * as v from 'valibot'
import { getDevRuntimeHandles } from '../../runtime/dev-handles'
import { logsLatest, logsWaitFor } from '../usecases/logs'
import { logsLatestText, logsWaitForText } from '../usecases/logsLlm'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigReset,
	pluginConfigValidate,
	pluginSchema,
} from '../usecases/pluginConfig'
import { ensureFork } from '../usecases/pluginForks'
import { applyStatusActions } from '../usecases/pluginStatus'
import { pluginStatus, pluginsList } from '../usecases/plugins'
import { pluginWaitForStage } from '../usecases/pluginWait'
import { workspaceListEntries, workspaceResolveEntry } from '../usecases/workspace'

const handlerCache = new WeakMap<Context, (req: Request) => Promise<Response>>()

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

const textContent = (text: string) => ({ type: 'text' as const, text })
const textResult = <T>(text: string, structuredContent: T): ToolCallResult<T> => ({
	content: [textContent(text)],
	structuredContent,
})

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

const PluginNameInputSchema = v.object({
	name: v.string(),
})

const PluginActionOutputSchema = v.object({
	ok: v.boolean(),
	name: v.string(),
	error: v.optional(v.string()),
	commitError: v.optional(v.string()),
})

const PluginNameSchema = v.string()
const JsonRecordSchema = v.record(v.string(), v.unknown())

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

const PluginSourceSchema = v.object({
	kind: v.string(),
	moduleId: v.nullable(v.string()),
	packageName: v.nullable(v.string()),
	version: v.nullable(v.string()),
	tag: v.nullable(v.string()),
})

const PluginStatusSnapshotSchema = v.object({
	name: v.string(),
	isRunning: v.boolean(),
	isEnabled: v.boolean(),
	lifecycleStage: v.string(),
	source: PluginSourceSchema,
})

const PluginsListOutputSchema = v.object({
	plugins: v.array(PluginStatusSnapshotSchema),
	summary: v.object({
		total: v.number(),
		running: v.number(),
		stopped: v.number(),
		disabled: v.number(),
	}),
})

const PluginStatusOutputSchema = v.union([
	v.object({ ok: v.literal(true), status: PluginStatusSnapshotSchema }),
	v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
])

const PluginWaitForStageInputSchema = v.object({
	name: v.string(),
	stage: v.string(),
	timeoutMs: v.optional(v.number()),
	pollMs: v.optional(v.number()),
})

const PluginWaitForStageOutputSchema = v.union([
	v.object({
		ok: v.literal(true),
		name: v.string(),
		stage: v.string(),
		status: PluginStatusSnapshotSchema,
	}),
	v.object({
		ok: v.literal(false),
		name: v.string(),
		stage: v.string(),
		code: v.string(),
		message: v.string(),
		last: v.optional(PluginStatusSnapshotSchema),
	}),
])

	const PluginSchemaOutputSchema = v.union([
		v.object({
			ok: v.literal(true),
			schemaSource: v.record(v.string(), v.string()),
			defaults: JsonRecordSchema,
			layout: v.optional(v.nullable(v.array(v.unknown()))),
		}),
		v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
	])

const PluginConfigOutputSchema = v.union([
	v.object({
		ok: v.literal(true),
		saved: v.boolean(),
		config: JsonRecordSchema,
		defaults: JsonRecordSchema,
	}),
	v.object({
		ok: v.literal(false),
		code: v.string(),
		message: v.string(),
		errors: v.optional(v.unknown()),
		defaults: v.optional(JsonRecordSchema),
	}),
])

const PluginConfigPatchInputSchema = v.object({
	name: PluginNameSchema,
	patch: JsonRecordSchema,
})

const PluginConfigResetInputSchema = v.object({
	name: PluginNameSchema,
	keys: v.optional(v.array(v.string())),
})

const HmrLastBatchOutputSchema = v.object({ batch: v.nullable(WaitForBatchOutputSchema) })

const HmrExecuteFilesInputSchema = v.object({
	files: v.array(v.string()),
	keepOrder: v.optional(v.boolean()),
})

const HmrExecuteFilesOutputSchema = v.object({ ok: v.literal(true) })

const EnsureForkInputSchema = v.object({
	baseName: v.string(),
	forkId: v.string(),
	enable: v.optional(v.boolean()),
})

const EnsureForkOutputSchema = v.union([
	v.object({ ok: v.literal(true), forkName: v.string() }),
	v.object({ ok: v.literal(false), code: v.string(), error: v.string() }),
])

function createPluxelMcpServer(ctx: Context) {
	const requireHmr = () => {
		const handles = getDevRuntimeHandles(ctx)
		const hmr = handles?.hmr
		if (hmr) return hmr

		throw new Error('HMR runtime not available (did you start the Vite dev runtime?)')
	}

	const server = new McpServer({
		name: 'pluxel-hmr',
		version: 'dev',
		schemaAdapter: (schema) => toJsonSchema(schema as any) as Record<string, unknown>,
	})

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
			const afterSeq = typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
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
			const afterSeq = typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
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
			const afterSeq = typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
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
			const afterSeq = typeof args.afterSeq === 'string' && args.afterSeq ? args.afterSeq : undefined
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

	const pluginAction = async (
		name: string,
		action: 'start' | 'stop' | 'restart' | 'enable' | 'disable',
	): Promise<ToolCallResult<unknown>> => {
		const batch = await applyStatusActions(ctx, [{ name, action }])
		if (!batch.ok) {
			const msg = batch.commitError ? `commit failed: ${batch.commitError}` : 'plugin action failed'
			return textResult(msg, {
				ok: false as const,
				name,
				error: msg,
				...(batch.commitError ? { commitError: batch.commitError } : {}),
			})
		}
		const first = batch.results[0] as { ok?: boolean; error?: unknown } | undefined
		const err =
			typeof first?.error === 'string'
				? first.error
				: first?.ok === false
					? 'plugin action failed'
					: undefined
		return textResult(`${action} ${name}: ${first?.ok ? 'ok' : 'failed'}`, {
			ok: Boolean(first?.ok),
			name,
			...(err ? { error: err } : {}),
		})
	}

	server.tool('plugin.start', {
		description: 'Start a plugin by name (commit included).',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginActionOutputSchema,
		handler: (args) => pluginAction(args.name, 'start'),
	})

	server.tool('plugin.stop', {
		description: 'Stop a plugin by name (commit included).',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginActionOutputSchema,
		handler: (args) => pluginAction(args.name, 'stop'),
	})

	server.tool('plugin.restart', {
		description: 'Restart a plugin by name (commit included).',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginActionOutputSchema,
		handler: (args) => pluginAction(args.name, 'restart'),
	})

	server.tool('plugin.enable', {
		description: 'Enable a plugin in persisted config (commit included).',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginActionOutputSchema,
		handler: (args) => pluginAction(args.name, 'enable'),
	})

	server.tool('plugin.disable', {
		description: 'Disable a plugin in persisted config (commit included).',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginActionOutputSchema,
		handler: (args) => pluginAction(args.name, 'disable'),
	})

	server.tool('plugin.ensureFork', {
		description: 'Ensure a fork exists for a forkable plugin (optionally enable it).',
		inputSchema: EnsureForkInputSchema,
		outputSchema: EnsureForkOutputSchema,
		handler: async (args) => {
			const out = await ensureFork(ctx, args.baseName, args.forkId, { enable: args.enable })
			const msg = out.ok === true ? out.forkName : out.error
			return textResult(msg, out)
		},
	})

	server.tool('plugins.list', {
		description: 'List registered plugins with running/enabled status (source + lifecycle stage).',
		inputSchema: v.object({}),
		outputSchema: PluginsListOutputSchema,
		handler: () => {
			const out = pluginsList(ctx)
			return textResult(`plugins: ${out.summary.total} (running=${out.summary.running})`, out)
		},
	})

	server.tool('plugin.status', {
		description: 'Get a plugin status snapshot by name.',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginStatusOutputSchema,
		handler: (args) => {
			const status = pluginStatus(ctx, args.name)
			if (!status) {
				return textResult(`Plugin not found: ${args.name}`, {
					ok: false as const,
					code: 'plugin_not_found',
					message: `Plugin not found: ${args.name}`,
				})
			}
			return textResult(`${args.name}: ${status.lifecycleStage}`, {
				ok: true as const,
				status,
			})
		},
	})

	server.tool('plugin.waitForStage', {
		description: 'Wait until a plugin reaches the given lifecycle stage (polling).',
		inputSchema: PluginWaitForStageInputSchema,
		outputSchema: PluginWaitForStageOutputSchema,
		handler: async (args) => {
			const out = await pluginWaitForStage(ctx, {
				name: args.name,
				stage: args.stage,
				timeoutMs: args.timeoutMs,
				pollMs: args.pollMs,
			})
			const msg =
				out.ok === true ? `${out.name}: ${out.status.lifecycleStage}` : (out as any).message
			return textResult(msg, out)
		},
	})

	server.tool('plugin.schema', {
		description: 'Get plugin config schema source + defaults (for editing config safely).',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginSchemaOutputSchema,
		handler: async (args) => {
			const out = await pluginSchema(ctx, args.name)
			let msg: string
			if (out.ok === true) {
				msg = `schema: ok (${Object.keys(out.schemaSource).length} fields)`
			} else {
				msg = `schema: ${out.code}`
			}
			return textResult(msg, out)
		},
	})

	server.tool('plugin.config.get', {
		description: 'Read saved config + defaults for a plugin.',
		inputSchema: PluginNameInputSchema,
		outputSchema: PluginConfigOutputSchema,
		handler: async (args) => {
			const out = await pluginConfigGet(ctx, args.name)
			const msg = out.ok === true ? 'ok' : out.message
			return textResult(msg, out)
		},
	})

	server.tool('plugin.config.validate', {
		description: 'Validate a config patch without saving.',
		inputSchema: PluginConfigPatchInputSchema,
		outputSchema: PluginConfigOutputSchema,
		handler: async (args) => {
			const out = await pluginConfigValidate(ctx, args.name, args.patch)
			const msg = out.ok === true ? 'ok' : out.message
			return textResult(msg, out)
		},
	})

	server.tool('plugin.config.patch', {
		description: 'Validate and persist a config patch for a plugin.',
		inputSchema: PluginConfigPatchInputSchema,
		outputSchema: PluginConfigOutputSchema,
		handler: async (args) => {
			const out = await pluginConfigPatch(ctx, args.name, args.patch)
			const msg = out.ok === true ? 'saved' : out.message
			return textResult(msg, out)
		},
	})

	server.tool('plugin.config.reset', {
		description: 'Reset plugin config keys (or all keys if omitted).',
		inputSchema: PluginConfigResetInputSchema,
		outputSchema: PluginConfigOutputSchema,
		handler: async (args) => {
			const out = await pluginConfigReset(ctx, args.name, args.keys)
			const msg = out.ok === true ? 'reset' : out.message
			return textResult(msg, out)
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

	return server
}

export function getHmrMcpHttpHandler(ctx: Context): (req: Request) => Promise<Response> {
	const cached = handlerCache.get(ctx)
	if (cached) return cached

	const server = createPluxelMcpServer(ctx)
	const transport = new StreamableHttpTransport({
		sessionAdapter: new InMemorySessionAdapter({ maxEventBufferSize: 1024 }),
	})
	const handler = transport.bind(server)

	const wrapped = async (req: Request) => await handler(req)
	handlerCache.set(ctx, wrapped)
	return wrapped
}
