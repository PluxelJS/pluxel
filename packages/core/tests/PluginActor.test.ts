import { describe, expect, it, vi } from 'vitest'

import type { PluginLifecycleAdapter } from '../src/plugins/composition/BasePlugin'
import { PluginLifecycleActor } from '../src/plugins/runtime/PluginActor'

describe('PluginLifecycleActor', () => {
	it('drains an unstarted generation through stopping without an illegal follow-up transition', async () => {
		const drain = vi.fn(async () => {})
		const actorErrors: unknown[] = []
		const runtime: PluginLifecycleAdapter = { drain }
		const actor = new PluginLifecycleActor(
			{ autoStart: false, useErrorChannel: false },
			{ id: 'idle-generation', runtime },
		)
		actor.subscribe({ error: (error) => actorErrors.push(error) })

		actor.start()
		actor.send({ type: 'STOP' })
		const stopped = await actor.waitForStopped(1_000)

		expect(stopped.value).toBe('stopped')
		expect(drain).toHaveBeenCalledOnce()
		expect(actorErrors).toEqual([])
	})
})
