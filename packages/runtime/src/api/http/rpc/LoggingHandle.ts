import type { Context } from '@pluxel/core'
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
		pluginId: string,
		level: RuntimePluginLogLevel,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.policy(expectedRevision)
		return policy.setPluginLevel(pluginId, level)
	}

	async clearPluginLevel(
		expectedRevision: number,
		pluginId: string,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.policy(expectedRevision)
		return policy.clearPluginLevel(pluginId)
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
