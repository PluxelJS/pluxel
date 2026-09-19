import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { describe, expect, it } from 'vitest'
import { defineHostService } from '../src/services'
import { resolveHostApplication, runHostApplication } from '../src/application'
import type { HostApplication } from '../src/host'

describe('shared Host application startup', () => {
	it('resolves runtime configuration afresh and rolls prepared resources back when application preparation fails', async () => {
		const events: string[] = []
		const application: HostApplication = {
			plugins: [],
			configure({ env }) {
				events.push(`configure:${env.VALUE}`)
				return {
					services: [
						defineHostService({
							name: 'ApplicationResource',
							capabilities: [
								installRootCapability(defineContextCapability<string>('ApplicationResource'), {
									create: () => env.VALUE!,
								}),
							],
							prepare({ effects }) {
								events.push(`prepare:${env.VALUE}`)
								effects.defer(() => {
									events.push(`close:${env.VALUE}`)
								})
							},
						}),
					],
				}
			},
			prepare({ startup }) {
				if (startup.env.VALUE === 'fail') throw new Error('application prerequisite failed')
			},
		}
		const startup = {
			root: process.cwd(),
			mode: 'test' as const,
			bindings: {},
			env: { VALUE: 'one' },
		}
		const host = await runHostApplication(application, { startup })
		await host.close()
		await expect(
			runHostApplication(application, { startup: { ...startup, env: { VALUE: 'fail' } } }),
		).rejects.toThrow('application prerequisite failed')
		expect(events).toEqual([
			'configure:one',
			'prepare:one',
			'close:one',
			'configure:fail',
			'prepare:fail',
			'close:fail',
		])
		await expect(
			resolveHostApplication(
				{
					...application,
					configure: () => ({ plugins: [] as readonly unknown[] }),
				} as unknown as HostApplication,
				startup,
			),
		).rejects.toThrow('unsupported "plugins"')
	})
})
