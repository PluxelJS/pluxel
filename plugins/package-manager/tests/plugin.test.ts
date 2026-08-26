import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { assertPluginLifecycleIssue, withRuntimeHost } from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManagerPlugin } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PackageManagerPlugin', () => {
	it('fails before filesystem or command side effects outside a declared dynamic source', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-plugin-'))
		roots.push(root)
		const managedRoot = resolve(root, 'managed')

		await withRuntimeHost(
			async (host) => {
				host.add(PackageManagerPlugin)
				host.cfg(PackageManagerPlugin).set({
					rootDir: managedRoot,
					ignoreScripts: true,
					allowBuilds: [],
					minimumReleaseAgeMinutes: 0,
				})
				host.cfg(PackageManagerPlugin).enable()
				const summary = await host.commitAllowFail()

				assertPluginLifecycleIssue(summary, PackageManagerPlugin, {
					kind: 'start-failed',
					message: 'dynamic runtime host',
				})
				expect(host.isRunning(PackageManagerPlugin)).toBe(false)
				expect(existsSync(managedRoot)).toBe(false)
				expect(host.ctx.commands.list().some(({ name }) => name === 'package.install')).toBe(false)
				expect(host.ctx.commands.list().some(({ name }) => name === 'package.remove')).toBe(false)
			},
			{ workbench: false },
		)
	})
})
