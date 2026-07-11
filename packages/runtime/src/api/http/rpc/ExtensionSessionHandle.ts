import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import type {
	ExtensionSessionCommitInput,
	ExtensionSessionDraftSyncInput,
	ExtensionSessionHandleApi,
	ExtensionSessionLoadResult,
	ExtensionSessionMutationResult,
} from '../../../web/protocol'
import { requireWebManagement } from '../../../services/web-management/WebManagementService'

export class ExtensionSessionHandle extends RpcTarget implements ExtensionSessionHandleApi {
	constructor(private readonly ctx: Context) {
		super()
	}

	async loadSession(sessionId: string): Promise<ExtensionSessionLoadResult> {
		return await requireWebManagement(this.ctx).ui.loadSession(String(sessionId ?? '').trim())
	}

	async syncDraft(input: ExtensionSessionDraftSyncInput): Promise<ExtensionSessionMutationResult> {
		return await requireWebManagement(this.ctx).ui.syncDraft({
			sessionId: String(input?.sessionId ?? '').trim(),
			draft: input?.draft,
		})
	}

	async commitSession(input: ExtensionSessionCommitInput): Promise<ExtensionSessionMutationResult> {
		return await requireWebManagement(this.ctx).ui.commitSession({
			sessionId: String(input?.sessionId ?? '').trim(),
			result: input?.result,
		})
	}
}
