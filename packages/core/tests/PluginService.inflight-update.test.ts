import type { StandardSchemaV1 } from '@standard-schema/spec'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'

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

describe('updates attempted during an in-flight Core transaction', () => {
	beforeAll(() => {
		lowerTestReplacement(InflightUpdatePlugin, InflightReplacementPlugin, {
			plugin: { displayName: 'In-flight replacement' },
			config: { fieldName: 'config', schema: ConfigSchema },
		})
	})
	beforeEach(resetRace)

	it('rejects overlap and applies the latest config in the next generation', async () => {
		await withCoreHost(async (host) => {
			const config = host.cfg(InflightUpdatePlugin)
			config.set({ value: 1 })
			host.add(InflightUpdatePlugin)

			const initialCommit = host.commit()
			await started

			config.set({ value: 2 })
			expect(() => host.restart(InflightUpdatePlugin)).toThrow(/another update is active/i)

			allowInit()
			await initialCommit
			host.restart(InflightUpdatePlugin)
			await host.commit()

			expect(applied).toEqual([1, 2])
			expect(host.require(InflightUpdatePlugin).config.value).toBe(2)
		})
	})

	it('admits replacement only after the active transaction settles', async () => {
		await withCoreHost(async (host) => {
			host.cfg(InflightUpdatePlugin).set({ value: 1 })
			host.add(InflightUpdatePlugin)

			const initialCommit = host.commit()
			await started

			expect(() => host.replace(InflightUpdatePlugin, InflightReplacementPlugin)).toThrow(
				/another update is active/i,
			)

			allowInit()
			await initialCommit
			host.replace(InflightUpdatePlugin, InflightReplacementPlugin)
			await host.commit()

			expect(applied).toEqual([1, 20])
			expect(host.require(InflightUpdatePlugin)).toBeInstanceOf(InflightReplacementPlugin)
		})
	})

	it('admits removal only after the active transaction settles', async () => {
		await withCoreHost(async (host) => {
			host.cfg(InflightUpdatePlugin).set({ value: 1 })
			host.add(InflightUpdatePlugin)

			const initialCommit = host.commit()
			await started

			expect(() => host.remove(InflightUpdatePlugin)).toThrow(/another update is active/i)

			allowInit()
			await initialCommit
			host.remove(InflightUpdatePlugin)
			await host.commit()

			expect(applied).toEqual([1])
			expect(host.has(InflightUpdatePlugin)).toBe(false)
			expect(host.isRunning(InflightUpdatePlugin)).toBe(false)
		})
	})
})
