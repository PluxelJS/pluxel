import { standardServices } from '@pluxel/services'
import { NodeModuleHost } from '../../src/node/token'
import { NodeModules, defineNodeModule } from '@pluxel/services/node'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { pluginNodeAddressOf } from '@pluxel/core'

import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const declaration = defineNodeModule(import.meta.url, './fixtures/task.ts')

describe('NodeModuleService', () => {
	it('makes the first build/setup failure fail plugin startup', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false })

		host.ctx.require(NodeModuleHost).attachSourceBinder(async () => {
			throw new Error('node build failed')
		})

		@Plugin({ displayName: 'NodeModuleFailure' })
		class NodeModuleFailure extends BasePlugin {
			override async init() {
				await this.ctx.require(NodeModules).use(declaration, (): undefined => undefined)
			}
		}

		lowerTestPlugin(NodeModuleFailure)
		const failure = await host.commitExpectFail((change) => {
			change.start(NodeModuleFailure)
		})
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				plugin: pluginNodeAddressOf(NodeModuleFailure),
				kind: 'start-failed',
				message: expect.stringContaining('node build failed'),
			}),
		)
		expect(host.isRunning(NodeModuleFailure)).toBe(false)
	})

	it('stages updates, keeps the last good consumer, and cleans up with its owner', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false })

		let publish!: (url: URL) => void | Promise<void>
		let sourceDisposals = 0
		host.ctx.require(NodeModuleHost).attachSourceBinder(async (_declaration, onUpdate) => {
			publish = onUpdate
			return {
				url: new URL('file:///cache/task-a.mjs'),
				dispose: () => void sourceDisposals++,
			}
		})
		const events: string[] = []

		@Plugin({ displayName: 'NodeModuleConsumer' })
		class NodeModuleConsumer extends BasePlugin {
			override async init() {
				await this.ctx.require(NodeModules).use(declaration, async (url) => {
					events.push(`setup:${url.pathname}`)
					if (url.pathname.endsWith('bad.mjs')) throw new Error('bad setup')
					return () => void events.push(`cleanup:${url.pathname}`)
				})
			}
		}

		lowerTestPlugin(NodeModuleConsumer)
		await host.start(NodeModuleConsumer)
		expect(host.isRunning(NodeModuleConsumer)).toBe(true)
		await publish(new URL('file:///cache/task-b.mjs'))
		await publish(new URL('file:///cache/bad.mjs'))
		expect(events).toEqual([
			'setup:/cache/task-a.mjs',
			'setup:/cache/task-b.mjs',
			'cleanup:/cache/task-a.mjs',
			'setup:/cache/bad.mjs',
		])

		await host.commit((change) => change.catalog.remove(NodeModuleConsumer))
		expect(events.at(-1)).toBe('cleanup:/cache/task-b.mjs')
		expect(sourceDisposals).toBe(1)
	})

	it('drains a pending update and late cleanup when the owner stops after source detach', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false })

		let publish!: (url: URL) => void | Promise<void>
		let releaseSetup!: () => void
		let setupStarted!: () => void
		const didStartSetup = new Promise<void>((resolve) => (setupStarted = resolve))
		const releaseSetupGate = new Promise<void>((resolve) => (releaseSetup = resolve))
		let sourceDisposed!: () => void
		const didDisposeSource = new Promise<void>((resolve) => (sourceDisposed = resolve))
		const events: string[] = []
		const detach = host.ctx
			.require(NodeModuleHost)
			.attachSourceBinder(async (_declaration, onUpdate) => {
				publish = onUpdate
				return {
					url: new URL('file:///cache/initial.mjs'),
					dispose: () => {
						events.push('source:dispose')
						sourceDisposed()
					},
				}
			})

		@Plugin({ displayName: 'PendingNodeModuleConsumer' })
		class PendingNodeModuleConsumer extends BasePlugin {
			override async init() {
				await this.ctx.require(NodeModules).use(declaration, async (url) => {
					events.push(`setup:${url.pathname}`)
					if (url.pathname.endsWith('/next.mjs')) {
						setupStarted()
						await releaseSetupGate
					}
					return () => void events.push(`cleanup:${url.pathname}`)
				})
			}
		}

		lowerTestPlugin(PendingNodeModuleConsumer)
		await host.start(PendingNodeModuleConsumer)
		const pendingUpdate = Promise.resolve(publish(new URL('file:///cache/next.mjs')))
		await didStartSetup

		detach()
		expect(events).toEqual(['setup:/cache/initial.mjs', 'setup:/cache/next.mjs'])

		let stopped = false
		const stopping = host
			.commit((change) => change.catalog.remove(PendingNodeModuleConsumer))
			.then((): void => {
				stopped = true
				return undefined
			})
		await didDisposeSource
		expect(stopped).toBe(false)

		releaseSetup()
		await pendingUpdate
		await stopping
		expect(events).toEqual([
			'setup:/cache/initial.mjs',
			'setup:/cache/next.mjs',
			'source:dispose',
			'cleanup:/cache/next.mjs',
			'cleanup:/cache/initial.mjs',
		])
	})

	it('loads the lowered artifact from a packaged/static root', async () => {
		await using fixture = await createFixture()
		const artifactRoot = `${fixture.path}/artifacts/node`
		await mkdir(artifactRoot, { recursive: true })
		await writeFile(`${fixture.path}/artifacts/node/node-fixture.mjs`, 'export const n = 1\n')
		const lowered = (defineNodeModule as unknown as (...args: unknown[]) => unknown)(
			import.meta.url,
			'./fixtures/task.ts',
			'node-fixture',
		) as typeof declaration
		await using host = await createServiceInternalTestHost({
			workbench: false,
			services: standardServices({
				persistence: { mode: 'memory' },
				nodeModules: { root: artifactRoot },
			}),
		})

		let received: URL | undefined
		@Plugin({ displayName: 'PackagedNodeModule' })
		class PackagedNodeModule extends BasePlugin {
			override async init() {
				await this.ctx.require(NodeModules).use(lowered, (url) => void (received = url))
			}
		}
		lowerTestPlugin(PackagedNodeModule)
		await host.start(PackagedNodeModule)
		expect(host.isRunning(PackagedNodeModule)).toBe(true)
		expect(received?.href).toBe(
			pathToFileURL(`${fixture.path}/artifacts/node/node-fixture.mjs`).href,
		)
	})
})
