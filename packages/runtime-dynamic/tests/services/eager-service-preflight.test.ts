import '@pluxel/runtime/services/vault'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { describe, expect, it } from 'vitest'
import { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from '../../src/hmr/host.ts'

let cleanupCount = 0
let stopCount = 0
const liveTimers = new Set<ReturnType<typeof setInterval>>()

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

	protected override async stop(): Promise<void> {
		stopCount++
	}
}
Plugin({ name: 'DynamicVaultConsumerPlugin' })(DynamicVaultConsumerPlugin)

describe('dynamic host eager service preflight', () => {
	it('prepares eager services before the initial plugin graph starts', async () => {
		cleanupCount = 0
		stopCount = 0
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-dynamic-eager-service-'))
		await mkdir(root, { recursive: true })
		await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
		await writeFile(
			resolve(root, 'pluxel.loader.hmr.jsonc'),
			JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		)

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
					snapshot: { enabled: ['DynamicVaultConsumerPlugin'] },
				},
				plugins: [DynamicVaultConsumerPlugin],
			})
			host = await bootPlannedLoaderHmrHost(plan)
			await host.hmr.start()
			const plugin = host.ctx.registry.getInstance(DynamicVaultConsumerPlugin)
			expect(plugin).toMatchObject({ started: true })
			await expect(
				host.ctx.vault.namespace('dynamic-preflight-test').kv().get('started'),
			).resolves.toBe(true)
			expect(await host.ctx.root.vaultAdmin.describe()).toMatchObject({
				present: true,
				unlocked: true,
			})
			await host.stop()
			expect(stopCount).toBe(1)
			expect(cleanupCount).toBe(1)
			expect(liveTimers.size).toBe(0)
			await host.stop()
			expect(stopCount).toBe(1)
			expect(cleanupCount).toBe(1)
		} finally {
			await host?.stop()
			for (const timer of liveTimers) clearInterval(timer)
			liveTimers.clear()
			await rm(root, { recursive: true, force: true })
		}
	}, 30_000)
})
