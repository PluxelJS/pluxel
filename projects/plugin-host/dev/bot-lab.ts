import type { ProjectScript } from '@pluxel/host-vite/project'
import { openLocalWorkbenchEntry, WorkbenchHost } from '@pluxel/workbench/server'
import { consumeWorkbenchValue, readWorkbenchLayout } from '@pluxel/workbench/client'
import { RpcStub } from 'capnweb'
import { BotWorkspacePlugin } from '../src/bot-lab/BotWorkspacePlugin'
import { DiscordBotPlugin } from '../src/bot-lab/BotSources'
import { BotWorkspaceWorkbench } from '../src/bot-lab/BotWorkspace.workbench'

const principal = { provider: 'development-console', subject: 'bot-lab-validation' }

/** Read the real aggregator, provider lifecycles, and target-scoped publications. */
export default ((sdk) =>
	sdk.Result.gen(async function* () {
		const plugins = yield* sdk.Result.await(sdk.plugins.list())
		const workspace = sdk.plugin(BotWorkspacePlugin)
		const owner = yield* sdk.Result.await(workspace.status())
		if (!owner) throw new Error('BotWorkspacePlugin is not registered')
		const instance = yield* sdk.Result.await(workspace.instance())
		const session = sdk.dev.ctx.require(WorkbenchHost).createSession(principal, () => {})
		try {
			using target = new RpcStub(session.target)
			const layout = await readWorkbenchLayout(target, { target: owner.address })
			return sdk.Result.ok({
				owner,
				providers: plugins.filter((plugin) =>
					['TelegramBotPlugin', 'DiscordBotPlugin', 'WeComBotPlugin'].includes(
						plugin.rootExportName ?? '',
					),
				),
				snapshot: instance.snapshot(),
				entries: layout.entries.map(({ descriptor, placement }) => ({
					key: descriptor.key,
					placement,
				})),
			})
		} finally {
			session.dispose()
		}
	})) satisfies ProjectScript

/** Exercise the actual entity-scoped Workbench API, never a frontend-owned mock store. */
export const saveInstructions = ((sdk, run) =>
	sdk.Result.gen(async function* () {
		const input = run.input
		if (!input || typeof input !== 'object' || Array.isArray(input))
			throw new TypeError('Expected source, id and instructions')
		const record = input as Record<string, unknown>
		if (typeof record.instructions !== 'string') throw new TypeError('Expected instructions string')
		const workspace = sdk.plugin(BotWorkspacePlugin)
		const instance = yield* sdk.Result.await(workspace.instance())
		const identity = instance.identity(record.source, record.id)
		const owner = yield* sdk.Result.await(workspace.status())
		if (!owner) throw new Error('BotWorkspacePlugin is not registered')
		using opened = await openLocalWorkbenchEntry(sdk.dev.ctx, {
			target: owner.address,
			entry: BotWorkspaceWorkbench.bot,
			principal,
			location: `/bot-lab/${identity.source}/${identity.id}`,
			signal: run.signal,
		})
		const before = await consumeWorkbenchValue(opened.api.snapshotDto(), 'Bot before save')
		const result = await consumeWorkbenchValue(
			opened.api.saveDto({ instructions: record.instructions, expectedRevision: before.revision }),
			'Bot save result',
		)
		const after = await consumeWorkbenchValue(opened.api.snapshotDto(), 'Bot after save')
		return sdk.Result.ok({ result, before, after })
	})) satisfies ProjectScript

export const stopDiscord = ((sdk) =>
	sdk.Result.gen(async function* () {
		const { stop, status } = sdk.plugin(DiscordBotPlugin)
		const report = yield* sdk.Result.await(stop())
		const current = yield* sdk.Result.await(status())
		const workspace = yield* sdk.Result.await(sdk.plugin(BotWorkspacePlugin).instance())
		return sdk.Result.ok({
			report,
			current,
			snapshot: workspace.snapshot(),
		})
	})) satisfies ProjectScript
export const startDiscord = ((sdk) =>
	sdk.Result.gen(async function* () {
		const { start, status } = sdk.plugin(DiscordBotPlugin)
		const report = yield* sdk.Result.await(start())
		const current = yield* sdk.Result.await(status())
		const workspace = yield* sdk.Result.await(sdk.plugin(BotWorkspacePlugin).instance())
		return sdk.Result.ok({
			report,
			current,
			snapshot: workspace.snapshot(),
		})
	})) satisfies ProjectScript
