import type { Context, PluginNodeAddressSnapshot } from '@pluxel/core'
import { RpcTarget } from 'capnweb'

import { requireContextRuntimeLogging } from '../../../logger/logging'
import type {
	PluginLogPolicySnapshot,
	PluginLogPolicyMutationResult,
	RuntimePluginLogLevel,
	VersionedPluginLogPolicySnapshot,
} from '../../../logger/policy'

export class LoggingHandle extends RpcTarget {
	constructor(private readonly ctx: Context) {
		super()
	}

	async getPolicy(): Promise<VersionedPluginLogPolicySnapshot> {
		const logging = requireContextRuntimeLogging(this.ctx)
		await logging.ready
		return logging.policy.describe()
	}

	async replacePolicy(
		expectedRevision: number,
		snapshot: PluginLogPolicySnapshot,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.policy(expectedRevision)
		return policy.replace(snapshot)
	}

	async setDefaultLevel(
		expectedRevision: number,
		level: RuntimePluginLogLevel,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.policy(expectedRevision)
		return policy.setDefaultLevel(level)
	}

	async setPluginLevel(
		expectedRevision: number,
		owner: PluginNodeAddressSnapshot,
		level: RuntimePluginLogLevel,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.policy(expectedRevision)
		return policy.setPluginLevel(owner, level)
	}

	async clearPluginLevel(
		expectedRevision: number,
		owner: PluginNodeAddressSnapshot,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.policy(expectedRevision)
		return policy.clearPluginLevel(owner)
	}

	async resetPolicy(expectedRevision: number): Promise<VersionedPluginLogPolicySnapshot> {
		const policy = await this.policy(expectedRevision)
		policy.reset()
		return policy.describe()
	}

	private async policy(expectedRevision: number) {
		const logging = requireContextRuntimeLogging(this.ctx)
		await logging.ready
		logging.policy.assertRevision(expectedRevision)
		return logging.policy
	}
}
