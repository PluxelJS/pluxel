import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { requirePluginService } from '@pluxel/core/internal'
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from '@pluxel/runtime-dynamic/hmr'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManagerPlugin } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PackageManagerPlugin dynamic source contract', () => {
	it('fails before side effects when the declared directory has a mismatched include', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-mismatch-'))
		roots.push(root)
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
		const previousCwd = process.cwd()
		const managedRoot = resolve(root, '.pluxel/managed-plugins')
		const plan = await planLoaderHmrHostFromConfig({
			root,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { enabled: [pluginNodeAddressOf(PackageManagerPlugin)] },
			},
			plugins: [PackageManagerPlugin],
			sources: [
				{
					kind: 'directory',
					path: '.pluxel/managed-plugins/entries',
					include: ['*.js'],
				},
			],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			await host.hmr.start()
			expect(
				requirePluginService(host.ctx).isRunning(pluginNodeAddressOf(PackageManagerPlugin)),
			).toBe(false)
			expect(existsSync(managedRoot)).toBe(false)
			expect(host.ctx.commands.get('package.install')).toBeUndefined()
		} finally {
			await host.stop()
			process.chdir(previousCwd)
		}
	}, 60_000)
})
