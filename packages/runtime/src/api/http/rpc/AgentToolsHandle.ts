import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import type { AgentToolsPolicyInput } from '../../../agent-tools'

export class AgentToolsHandle extends RpcTarget {
	constructor(private readonly ctx: Context) {
		super()
	}

	snapshot() {
		return this.ctx.root.agentTools.snapshot()
	}

	replacePolicy(expectedRevision: number, policy: AgentToolsPolicyInput) {
		return this.ctx.root.agentTools.replacePolicy(expectedRevision, policy)
	}
}
