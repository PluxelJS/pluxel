import type { StandardSchemaV1 } from '@standard-schema/spec'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import { clonePluginDefinition } from '../src/plugins/decorators/decorator/api'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const ConfigSchema: StandardSchemaV1<unknown, { value?: number }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({
			value:
				value && typeof value === 'object' && !Array.isArray(value)
					? (value as { value?: number })
					: {},
		}),
	},
}

let applied: number[]
let started: Promise<void>
let markStarted: () => void
let release: Promise<void>
let allowInit: () => void

function resetRace(): void {
	applied = []
	;({ promise: started, resolve: markStarted } = Promise.withResolvers<void>())
	;({ promise: release, resolve: allowInit } = Promise.withResolvers<void>())
}

@Plugin({ displayName: 'In-flight update' })
class InflightUpdatePlugin extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override async init(): Promise<void> {
		applied.push(this.config.value ?? 0)
		if (this.config.value !== 1) return
		markStarted()
		await release
	}
}

class InflightReplacementPlugin extends InflightUpdatePlugin {
	override async init(): Promise<void> {
		applied.push(20)
	}
}

describe('updates queued during an in-flight Plugin commit', () => {
	beforeAll(() => clonePluginDefinition(InflightUpdatePlugin, InflightReplacementPlugin))
	beforeEach(resetRace)

	it('applies the latest config in a fresh generation after init settles', async () => {
		await withCoreHost(async (host) => {
			const config = host.cfg(InflightUpdatePlugin)
			config.set({ value: 1 })
			host.add(InflightUpdatePlugin)

			const initialCommit = host.commit()
			await started

			config.set({ value: 2 })
			host.restart(InflightUpdatePlugin)
			const updateCommit = host.commit()

			allowInit()
			await initialCommit
			await updateCommit

			expect(applied).toEqual([1, 2])
			expect(host.require(InflightUpdatePlugin).config.value).toBe(2)
		})
	})

	it('does not lose a replacement queued while the old generation is starting', async () => {
		await withCoreHost(async (host) => {
			host.cfg(InflightUpdatePlugin).set({ value: 1 })
			host.add(InflightUpdatePlugin)

			const initialCommit = host.commit()
			await started

			host.replace(InflightUpdatePlugin, InflightReplacementPlugin)
			const replacementCommit = host.commit()

			allowInit()
			await initialCommit
			await replacementCommit

			expect(applied).toEqual([1, 20])
			expect(host.require(InflightUpdatePlugin)).toBeInstanceOf(InflightReplacementPlugin)
		})
	})

	it('removes a Plugin queued for unload while its generation is starting', async () => {
		await withCoreHost(async (host) => {
			host.cfg(InflightUpdatePlugin).set({ value: 1 })
			host.add(InflightUpdatePlugin)

			const initialCommit = host.commit()
			await started

			host.remove(InflightUpdatePlugin)
			const removalCommit = host.commit()

			allowInit()
			await initialCommit
			await removalCommit

			expect(applied).toEqual([1])
			expect(host.has(InflightUpdatePlugin)).toBe(false)
			expect(host.isRunning(InflightUpdatePlugin)).toBe(false)
		})
	})
})
