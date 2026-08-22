import '@pluxel/runtime/services/vault'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/runtime'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from '../../src/hmr/host.ts'

let cleanupCount = 0
const liveTimers = new Set<ReturnType<typeof setInterval>>()

@Plugin({ displayName: 'Dynamic vault consumer' })
class DynamicVaultConsumerPlugin extends BasePlugin {
	started = false

	override async init(): Promise<void> {
		await this.ctx.vault.namespace('dynamic-preflight-test').kv().set('started', true)
		await this.ctx.vault.flush()
		this.started = true
		const timer = setInterval(() => undefined, 60_000)
		liveTimers.add(timer)
		this.ctx.effects.defer(() => {
			clearInterval(timer)
			liveTimers.delete(timer)
			cleanupCount++
		})
	}
}

describe('dynamic host eager service preflight', () => {
	it('prepares eager services before the initial plugin graph starts', async () => {
		cleanupCount = 0
		await using fixture = await createDiskFixture({
			'pnpm-workspace.yaml': 'packages: []\n',
			'pluxel.loader.hmr.jsonc': JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		})
		const root = fixture.path

		let host: Awaited<ReturnType<typeof bootPlannedLoaderHmrHost>> | undefined
		try {
			const plan = await planLoaderHmrHostFromConfig({
				root,
				chdir: false,
				logging: false,
				printUrls: false,
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: [pluginNodeAddressOf(DynamicVaultConsumerPlugin)] },
				},
				plugins: [DynamicVaultConsumerPlugin],
			})
			host = await bootPlannedLoaderHmrHost(plan)
			await host.hmr.start()
			const pluginService = requirePluginService(host.ctx)
			const plugin = pluginService.getInstance(DynamicVaultConsumerPlugin)
			expect(plugin).toMatchObject({ started: true })
			await expect(
				host.ctx.vault.namespace('dynamic-preflight-test').kv().get('started'),
			).resolves.toBe(true)
			expect(await host.ctx.root.vaultAdmin.describe()).toMatchObject({
				present: true,
				unlocked: true,
			})
			expect(
				host.ctx.loader.api.registry.getCtor(pluginNodeAddressOf(DynamicVaultConsumerPlugin)),
			).toBe(DynamicVaultConsumerPlugin)
			await host.stop()
			expect(cleanupCount).toBe(1)
			expect(liveTimers.size).toBe(0)
			await host.stop()
			expect(cleanupCount).toBe(1)
		} finally {
			await host?.stop()
			for (const timer of liveTimers) clearInterval(timer)
			liveTimers.clear()
		}
	}, 30_000)
})
