import { NodeModuleHost } from '../../src/node/token'
import { nodeModules, NodeModules, defineNodeModule } from '@pluxel/services/node'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'

import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { parsePluginNodeAddress } from '@pluxel/core'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const declaration = defineNodeModule(import.meta.url, './fixtures/task.ts')

describe('NodeModuleService', () => {
	it('makes the first build/setup failure fail plugin startup', async () => {
		await using host = await createServiceInternalTestHost({ services: [nodeModules()] })

		host.ctx.service(NodeModuleHost).attachSourceBinder(async () => {
			throw new Error('node build failed')
		})

		@Plugin({ displayName: 'NodeModuleFailure' })
		class NodeModuleFailure extends BasePlugin {
			override async init() {
				await this.ctx.service(NodeModules).use(declaration, (): undefined => undefined)
			}
		}

		lowerTestPlugin(NodeModuleFailure)
		const failure = await host.commitExpectFail((change) => {
			change.start(NodeModuleFailure.nodeAddress())
		})
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				plugin: parsePluginNodeAddress(NodeModuleFailure.nodeAddress()),
				kind: 'start-failed',
				message: expect.stringContaining('node build failed'),
			}),
		)
		expect(host.isRunning(NodeModuleFailure.nodeAddress())).toBe(false)
	})

	it('retains the setup failure when its source cleanup also fails', async () => {
		await using host = await createServiceInternalTestHost({ services: [nodeModules()] })
		const setupFailure = new Error('consumer setup failed')
		const cleanupFailure = new Error('source cleanup failed')
		let caught: unknown
		host.ctx.service(NodeModuleHost).attachSourceBinder(async () => ({
			url: new URL('file:///cache/task.mjs'),
			dispose() {
				throw cleanupFailure
			},
		}))
		@Plugin({ displayName: 'NodeModuleSetupAndCleanupFailure' })
		class NodeModuleSetupAndCleanupFailure extends BasePlugin {
			override async init() {
				try {
					await this.ctx.service(NodeModules).use(declaration, () => {
						throw setupFailure
					})
				} catch (error) {
					caught = error
					throw error
				}
			}
		}
		lowerTestPlugin(NodeModuleSetupAndCleanupFailure)
		await host.commitExpectFail((change) =>
			change.start(NodeModuleSetupAndCleanupFailure.nodeAddress()),
		)
		expect(caught).toBeInstanceOf(AggregateError)
		expect((caught as AggregateError).cause).toBe(setupFailure)
		expect((caught as AggregateError).errors).toEqual([setupFailure, cleanupFailure])
	})

	it('stages updates, keeps the last good consumer, and cleans up with its owner', async () => {
		await using host = await createServiceInternalTestHost({ services: [nodeModules()] })

		let publish!: (url: URL) => void | Promise<void>
		let sourceDisposals = 0
		host.ctx.service(NodeModuleHost).attachSourceBinder(async (_declaration, onUpdate) => {
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
				await this.ctx.service(NodeModules).use(declaration, async (url) => {
					events.push(`setup:${url.pathname}`)
					if (url.pathname.endsWith('bad.mjs')) throw new Error('bad setup')
					return () => void events.push(`cleanup:${url.pathname}`)
				})
			}
		}

		lowerTestPlugin(NodeModuleConsumer)
		await host.start(NodeModuleConsumer.nodeAddress())
		expect(host.isRunning(NodeModuleConsumer.nodeAddress())).toBe(true)
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

	it.each([
		{ outcome: 'success', sourceDisposalFails: false },
		{ outcome: 'failure', sourceDisposalFails: true },
	])(
		'drains a pending update and cleans both consumers after source disposal $outcome',
		async ({ sourceDisposalFails }) => {
			await using host = await createServiceInternalTestHost({ services: [nodeModules()] })
			let publish!: (url: URL) => void | Promise<void>
			const setupStarted = Promise.withResolvers<void>()
			const releaseSetup = Promise.withResolvers<void>()
			const sourceDisposed = Promise.withResolvers<void>()
			const events: string[] = []
			const detach = host.ctx
				.service(NodeModuleHost)
				.attachSourceBinder(async (_declaration, onUpdate) => {
					publish = onUpdate
					return {
						url: new URL('file:///cache/initial.mjs'),
						dispose() {
							events.push('source:dispose')
							sourceDisposed.resolve()
							if (sourceDisposalFails) throw new Error('source disposal failed')
						},
					}
				})

			@Plugin({ displayName: 'PendingNodeModuleConsumer' })
			class PendingNodeModuleConsumer extends BasePlugin {
				override async init() {
					await this.ctx.service(NodeModules).use(declaration, async (url) => {
						events.push(`setup:${url.pathname}`)
						if (url.pathname.endsWith('/next.mjs')) {
							setupStarted.resolve()
							await releaseSetup.promise
						}
						return () => void events.push(`cleanup:${url.pathname}`)
					})
				}
			}

			lowerTestPlugin(PendingNodeModuleConsumer)
			await host.start(PendingNodeModuleConsumer.nodeAddress())
			const pendingUpdate = Promise.resolve(publish(new URL('file:///cache/next.mjs')))
			await setupStarted.promise

			try {
				detach()
				expect(events).toEqual(['setup:/cache/initial.mjs', 'setup:/cache/next.mjs'])

				let stopped = false
				const commit = sourceDisposalFails ? host.commitExpectFail : host.commit
				const stopping = commit((change) =>
					change.catalog.remove(PendingNodeModuleConsumer),
				).finally(() => {
					stopped = true
				})
				await sourceDisposed.promise
				expect(stopped).toBe(false)
				releaseSetup.resolve()
				await pendingUpdate
				const failure = await stopping
				const failureReport = expect.objectContaining({
					lifecycleReport: expect.objectContaining({
						issues: expect.arrayContaining([
							expect.objectContaining({
								kind: 'drain-failed',
								message: expect.stringContaining('source disposal failed'),
							}),
						]),
					}),
				})
				expect(failure).toEqual(sourceDisposalFails ? failureReport : undefined)
				expect(events).toEqual([
					'setup:/cache/initial.mjs',
					'setup:/cache/next.mjs',
					'source:dispose',
					'cleanup:/cache/next.mjs',
					'cleanup:/cache/initial.mjs',
				])
			} finally {
				releaseSetup.resolve()
			}
		},
	)

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
			services: [nodeModules({ root: artifactRoot })],
		})

		let received: URL | undefined
		@Plugin({ displayName: 'PackagedNodeModule' })
		class PackagedNodeModule extends BasePlugin {
			override async init() {
				await this.ctx.service(NodeModules).use(lowered, (url) => void (received = url))
			}
		}
		lowerTestPlugin(PackagedNodeModule)
		await host.start(PackagedNodeModule.nodeAddress())
		expect(host.isRunning(PackagedNodeModule.nodeAddress())).toBe(true)
		expect(received?.href).toBe(
			pathToFileURL(`${fixture.path}/artifacts/node/node-fixture.mjs`).href,
		)
	})
})
