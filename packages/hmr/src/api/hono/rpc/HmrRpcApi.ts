// rpc/HmrRpcApi.ts - 主 RPC API
import { writeFile } from 'node:fs/promises'
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { resolve } from 'pathe'
import * as v from 'valibot'

import { readGroups, writeGroups } from '../../features/groups/service'
import { PluginGroupInput, type PluginGroupInputValue } from '../../features/groups/schema'
import { getStatusOverview } from '../../features/pluginStatus/service'
import type { GroupMutationResult } from './types'
import { formatGroupIssues } from './utils'
import { PluginHandle } from './PluginHandle'

export class HmrRpcApi extends RpcTarget {
	#ctx: Context

	constructor(ctx: Context) {
		super()
		this.#ctx = ctx
	}

	ping() {
		return 'hmr-rpc:ok'
	}

	plugin(name: string) {
		return new PluginHandle(this.#ctx, name)
	}

	pluginStatus() {
		return getStatusOverview(this.#ctx)
	}

	async buildSnapshot() {
		try {
			const content = this.#ctx.loader.buildSnapshot()
			const path = resolve(process.cwd(), 'snapshot.ts')
			await writeFile(path, content, 'utf8')
			return { ok: true as const, path }
		} catch (error) {
			return { ok: false as const, error: (error as Error)?.message ?? 'Unknown error' }
		}
	}

	pluginGroups(): ReturnType<typeof readGroups> {
		return readGroups(this.#ctx)
	}

	updatePluginGroups(groups: PluginGroupInputValue[]): GroupMutationResult {
		const parsed = v.safeParse(v.array(PluginGroupInput), groups)
		if (!parsed.success) {
			return { ok: false, code: 'validation_failed', errors: formatGroupIssues(parsed.issues) }
		}
		return { ok: true, groups: writeGroups(this.#ctx, parsed.output) }
	}
}
