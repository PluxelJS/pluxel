import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import type {
	ExtensionSessionCommitInput,
	ExtensionSessionDraftSyncInput,
	ExtensionSessionHandleApi,
	ExtensionSessionLoadResult,
	ExtensionSessionMutationResult,
} from '../../../web/protocol'

export class ExtensionSessionHandle extends RpcTarget implements ExtensionSessionHandleApi {
	constructor(private readonly ctx: Context) {
		super()
	}

	async loadSession(sessionId: string): Promise<ExtensionSessionLoadResult> {
		return await this.ctx.ext.ui.loadSession(String(sessionId ?? '').trim())
	}

	async syncDraft(
		input: ExtensionSessionDraftSyncInput,
	): Promise<ExtensionSessionMutationResult> {
		return await this.ctx.ext.ui.syncDraft({
			sessionId: String(input?.sessionId ?? '').trim(),
			draft: input?.draft,
		})
	}

	async commitSession(
		input: ExtensionSessionCommitInput,
	): Promise<ExtensionSessionMutationResult> {
		return await this.ctx.ext.ui.commitSession({
			sessionId: String(input?.sessionId ?? '').trim(),
			result: input?.result,
		})
	}
}
