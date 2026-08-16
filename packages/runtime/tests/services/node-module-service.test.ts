import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { defineNodeModule } from '@pluxel/runtime'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const declaration = defineNodeModule(import.meta.url, './fixtures/task.ts')

describe('NodeModuleService', () => {
	it('makes the first build/setup failure fail plugin startup', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.ctx.nodeModules.attachSourceBinder(async () => {
				throw new Error('node build failed')
			})

			@Plugin()
			class NodeModuleFailure extends BasePlugin {
				override async init() {
					await this.ctx.nodeModules.use(declaration, () => undefined)
				}
			}

			lowerTestPlugin(NodeModuleFailure)
			host.add(NodeModuleFailure)
			host.cfg(NodeModuleFailure).enable()
			await expect(host.commit()).rejects.toThrow('Some plugins failed to start')
			expect(host.isRunning(NodeModuleFailure)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('stages updates, keeps the last good consumer, and cleans up with its owner', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			let publish!: (url: URL) => void | Promise<void>
			let sourceDisposals = 0
			host.ctx.nodeModules.attachSourceBinder(async (_declaration, onUpdate) => {
				publish = onUpdate
				return {
					url: new URL('file:///cache/task-a.mjs'),
					dispose: () => void sourceDisposals++,
				}
			})
			const events: string[] = []

			@Plugin()
			class NodeModuleConsumer extends BasePlugin {
				override async init() {
					await this.ctx.nodeModules.use(declaration, async (url) => {
						events.push(`setup:${url.pathname}`)
						if (url.pathname.endsWith('bad.mjs')) throw new Error('bad setup')
						return () => void events.push(`cleanup:${url.pathname}`)
					})
				}
			}

			lowerTestPlugin(NodeModuleConsumer)
			host.add(NodeModuleConsumer)
			host.cfg(NodeModuleConsumer).enable()
			await host.commit()
			expect(host.isRunning(NodeModuleConsumer)).toBe(true)
			await publish(new URL('file:///cache/task-b.mjs'))
			await publish(new URL('file:///cache/bad.mjs'))
			expect(events).toEqual([
				'setup:/cache/task-a.mjs',
				'setup:/cache/task-b.mjs',
				'cleanup:/cache/task-a.mjs',
				'setup:/cache/bad.mjs',
			])

			host.remove(NodeModuleConsumer)
			await host.commit()
			expect(events.at(-1)).toBe('cleanup:/cache/task-b.mjs')
			expect(sourceDisposals).toBe(1)
		} finally {
			await host.dispose()
		}
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
		const host = createRuntimeHost({ workbench: false, nodeModuleArtifactRoot: artifactRoot })
		try {
			let received: URL | undefined
			@Plugin()
			class PackagedNodeModule extends BasePlugin {
				override async init() {
					await this.ctx.nodeModules.use(lowered, (url) => void (received = url))
				}
			}
			lowerTestPlugin(PackagedNodeModule)
			host.add(PackagedNodeModule)
			host.cfg(PackagedNodeModule).enable()
			await host.commit()
			expect(host.isRunning(PackagedNodeModule)).toBe(true)
			expect(received?.href).toBe(
				pathToFileURL(`${fixture.path}/artifacts/node/node-fixture.mjs`).href,
			)
		} finally {
			await host.dispose()
		}
	})
})
