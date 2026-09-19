import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname } from 'pathe'
import { defineNodeModule } from '@pluxel/services/node'
import { createCoreInternalTestHost } from '@pluxel/core/internal/test'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { NodeArtifactCompiler } from '@pluxel/services/node/vite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const nodeBuildMocks = vi.hoisted(() => ({
	buildNodeModule: vi.fn(),
	validateNodeModuleArtifact: vi.fn(),
}))
vi.mock('@pluxel/rolldown/vite/node-module', () => nodeBuildMocks)
describe('Node artifact compiler', () => {
	beforeEach(() => {
		nodeBuildMocks.buildNodeModule
			.mockReset()
			.mockImplementation(async (input: { outFile: string }) => {
				await mkdir(dirname(input.outFile), { recursive: true })
				await writeFile(input.outFile, 'export const ready = true\n')
			})
		nodeBuildMocks.validateNodeModuleArtifact.mockReset().mockResolvedValue(undefined)
	})
	it('shares Node builds, reports failed rebuilds, and keeps the last good artifact', async () => {
		await using fixture = await createDiskFixture({
			'plugin.ts': 'export const plugin = true\n',
			'task.ts': 'export const version = 1\n',
		})
		const host = createCoreInternalTestHost()
		const compiler = new NodeArtifactCompiler(host.ctx, {
			cacheDir: fixture.getPath('.pluxel/artifacts'),
		})
		const declaration = defineNodeModule(pathToFileURL(fixture.getPath('plugin.ts')), './task.ts')
		const updates: URL[][] = [[], []]
		const errors: unknown[][] = [[], []]
		const consumers = await Promise.all(
			[0, 1].map((index) =>
				compiler.watchNodeModule(
					declaration,
					(url) => void updates[index]!.push(url),
					(error) => errors[index]!.push(error),
				),
			),
		)
		expect(nodeBuildMocks.buildNodeModule).toHaveBeenCalledTimes(1)
		expect(nodeBuildMocks.validateNodeModuleArtifact).not.toHaveBeenCalled()
		expect(consumers[0]!.url).toEqual(consumers[1]!.url)

		const internals = compiler as unknown as {
			nodeEntries: Map<string, { dirty: boolean }>
			compileNodeEntry(entry: { dirty: boolean }, initial: boolean): Promise<void>
		}
		const entry = [...internals.nodeEntries.values()][0]!
		const rebuildError = new Error('broken rebuild')
		nodeBuildMocks.buildNodeModule.mockRejectedValueOnce(rebuildError)
		await writeFile(fixture.getPath('task.ts'), 'export const version = 2\n')
		entry.dirty = true
		await internals.compileNodeEntry(entry, false)
		expect(errors).toEqual([[rebuildError], [rebuildError]])
		expect(updates).toEqual([[], []])

		await writeFile(fixture.getPath('task.ts'), 'export const version = 3\n')
		entry.dirty = true
		await internals.compileNodeEntry(entry, false)
		expect(updates.map((items) => items.length)).toEqual([1, 1])
		expect(nodeBuildMocks.buildNodeModule).toHaveBeenCalledTimes(3)

		await Promise.all(consumers.map((consumer) => consumer.dispose()))
		await compiler.dispose()
		await host.dispose()
	})
})
