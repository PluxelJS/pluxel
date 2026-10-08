import type { Context, PluginNodeAddress } from '@pluxel/core'
import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
export type ObservationOutcome = 'completed' | 'failed' | 'cancelled'
export interface ObservationResult {
	outcome: ObservationOutcome
	origin?: string
	method?: string
	status?: number
	durationMs: number
	bodyBytesRead: number
}
type Capability = {
	name: string
	acquired: number
	calls: number
	active: number
	completed: number
	failed: number
	cancelled: number
	last: ObservationResult | null
}
type Owner = {
	observationId: number
	node: PluginNodeAddress | null
	plugin: string
	retired: boolean
	capabilities: Capability[]
}
export class ObservationStore {
	private sequence = 0
	private dropped = 0
	private readonly records = new Map<Context, Owner>()
	acquire(owner: Context, name: string) {
		let record = this.records.get(owner)
		if (!record) {
			for (const [context, item] of this.records) {
				if (this.records.size < 64) break
				if (item.retired) this.records.delete(context)
			}
			if (this.records.size >= 64) {
				this.dropped++
				return {
					begin:
						() =>
						(_result: Omit<ObservationResult, 'durationMs'>): void => {},
				}
			}
			record = {
				observationId: ++this.sequence,
				node: owner.pluginInfo?.nodeAddress ?? null,
				plugin: owner.pluginInfo?.nodeAddress.definition.exportName ?? 'unknown',
				retired: false,
				capabilities: [],
			}
			this.records.set(owner, record)
			const owned = record
			owner.effects.defer(
				() => {
					owned.retired = true
				},
				{ tag: 'Capability observation' },
			)
		}
		let capability = record.capabilities.find((item) => item.name === name)
		if (!capability) {
			capability = {
				name,
				acquired: 0,
				calls: 0,
				active: 0,
				completed: 0,
				failed: 0,
				cancelled: 0,
				last: null,
			}
			record.capabilities.push(capability)
		}
		capability.acquired++
		return {
			begin: () => {
				capability.calls++
				capability.active++
				const started = performance.now()
				let ended = false
				return (result: Omit<ObservationResult, 'durationMs'>) => {
					if (ended) return
					ended = true
					capability.active--
					capability[result.outcome]++
					capability.last = { ...result, durationMs: Math.max(0, performance.now() - started) }
				}
			},
		}
	}
	snapshot() {
		return {
			dropped: this.dropped,
			scope: 'observed-session',
			coverage: 'Application Services only; global IO is unobserved',
			installed: ['Launcher', 'Clipboard', 'Desktop', 'Network'],
			owners: [...this.records.values()].map((owner) => ({
				observationId: owner.observationId,
				node: owner.node,
				plugin: owner.plugin,
				retired: owner.retired,
				capabilities: owner.capabilities.map((item) =>
					Object.assign({}, item, { last: item.last ? Object.assign({}, item.last) : null }),
				),
			})),
		}
	}
}
export const Observations = defineContextCapability<ObservationStore>('launcher.observations', {
	access: 'root',
})
export function observations() {
	return defineHostService({
		name: 'Capability observations',
		capabilities: [installRootCapability(Observations, { create: () => new ObservationStore() })],
	})
}
export type ObservationHandle = ReturnType<ObservationStore['acquire']>
export async function observeAsync<T>(
	handle: ObservationHandle | undefined,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const finish = handle?.begin()
	try {
		const result = await run()
		finish?.({ outcome: 'completed', bodyBytesRead: 0 })
		return result
	} catch (error) {
		finish?.({ outcome: signal?.aborted ? 'cancelled' : 'failed', bodyBytesRead: 0 })
		throw error
	}
}
