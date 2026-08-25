import { requireConfigService } from '../../../internal/config-service'
import type { PluginService } from '../PluginService'
import type { PluginNodeAddress } from '../identity'
import {
	notifyPluginConfigGeneration,
	type PluginConfigNotificationResult,
} from '../../composition/ConfigUpdate'

export type { PluginConfigNotificationResult } from '../../composition/ConfigUpdate'

export async function notifyRunningPluginConfigUpdate(
	service: PluginService,
	owner: PluginNodeAddress,
	desired: Readonly<Record<string, unknown>>,
	desiredRevision: number,
): Promise<PluginConfigNotificationResult> {
	const generation = service.getInstance(owner)
	if (!generation) return Object.freeze({ status: 'generation_changed' })
	const result = await notifyPluginConfigGeneration(generation, desired)
	if (result.status !== 'applied') return result
	if (service.getInstance(owner) !== generation) {
		return Object.freeze({ status: 'generation_changed' })
	}
	requireConfigService(service.ctx).markConfigApplied(owner, desiredRevision)
	return result
}
