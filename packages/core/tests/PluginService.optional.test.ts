import { BasePlugin, Plugin, definePluginRef, withCoreHost } from '@pluxel/core/test'
import { clonePluginDefinition } from '../src/plugins/decorators/decorator/api'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	OptionalProvider as OptionalProviderCtor,
	resetOptionalProvider,
	setOptionalProviderFailure,
	type OptionalProvider as OptionalProviderType,
} from './plugins/OptionalProvider'
import {
	resetSecondOptionalProvider,
	SecondOptionalProvider as SecondOptionalProviderCtor,
	type SecondOptionalProvider as SecondOptionalProviderType,
} from './plugins/SecondOptionalProvider'

const OptionalProviderRef = definePluginRef<OptionalProviderType>()
const SecondOptionalProviderRef = definePluginRef<SecondOptionalProviderType>()

let consumerStarts = 0
let consumerCleanups = 0
let integrationCleanups = 0
const observedGenerations: string[] = []

@Plugin({ displayName: 'Optional consumer' })
class OptionalConsumer extends BasePlugin {
	readonly generation = ++consumerStarts

	override init() {
		this.plugins.use(OptionalProviderRef, (provider) => {
			observedGenerations.push(`first:${provider.generation}`)
			return () => {
				integrationCleanups++
			}
		})
		this.plugins.use(SecondOptionalProviderRef, (provider) => {
			observedGenerations.push(`second:${provider.generation}`)
			return () => {
				integrationCleanups++
			}
		})
		return () => {
			consumerCleanups++
		}
	}
}

class OptionalProviderReplacement extends OptionalProviderCtor {}
clonePluginDefinition(OptionalProviderCtor, OptionalProviderReplacement)

describe('static optional Plugin integration', () => {
	beforeEach(() => {
		consumerStarts = 0
		consumerCleanups = 0
		integrationCleanups = 0
		observedGenerations.length = 0
		resetOptionalProvider()
		resetSecondOptionalProvider()
	})

	it('does not disturb consumers on absent -> absent retries and restarts them on real transitions', async () => {
		await withCoreHost(async (host) => {
			await host.start(OptionalConsumer)
			const initiallyAbsent = host.require(OptionalConsumer)
			expect(observedGenerations).toEqual([])

			setOptionalProviderFailure(true)
			host.add(OptionalProviderCtor)
			await host.commitAllowFail()
			expect(host.require(OptionalConsumer)).toBe(initiallyAbsent)
			expect(consumerStarts).toBe(1)

			await host.commitAllowFail()
			expect(host.require(OptionalConsumer)).toBe(initiallyAbsent)
			expect(consumerStarts).toBe(1)

			setOptionalProviderFailure(false)
			await host.commit()
			expect(host.require(OptionalConsumer)).not.toBe(initiallyAbsent)
			expect(consumerStarts).toBe(2)
			expect(observedGenerations).toHaveLength(1)

			host.restart(OptionalProviderCtor)
			await host.commit()
			expect(consumerStarts).toBe(3)
			expect(observedGenerations).toHaveLength(2)

			setOptionalProviderFailure(true)
			host.restart(OptionalProviderCtor)
			await host.commitAllowFail()
			const runningAbsent = host.require(OptionalConsumer)
			expect(consumerStarts).toBe(4)
			expect(observedGenerations).toHaveLength(2)

			await host.commitAllowFail()
			expect(host.require(OptionalConsumer)).toBe(runningAbsent)
			expect(consumerStarts).toBe(4)

			setOptionalProviderFailure(false)
			await host.commit()
			expect(consumerStarts).toBe(5)
			expect(observedGenerations).toHaveLength(3)

			host.remove(OptionalProviderCtor)
			await host.commit()
			expect(consumerStarts).toBe(6)
			expect(observedGenerations).toHaveLength(3)
			expect(consumerCleanups).toBe(5)
			expect(integrationCleanups).toBe(3)
		})
	})

	it('restarts one consumer generation for provider replacement', async () => {
		await withCoreHost(async (host) => {
			host.add([OptionalProviderCtor, OptionalConsumer])
			await host.commit()
			const first = host.require(OptionalConsumer)

			host.replace(OptionalProviderCtor, OptionalProviderReplacement)
			const summary = await host.commit()

			expect(host.require(OptionalConsumer)).not.toBe(first)
			expect(consumerStarts).toBe(2)
			expect(observedGenerations).toHaveLength(2)
			expect(summary.pluginChanges.restarted).toEqual([
				host.ctx.registry.resolvePluginNode(OptionalConsumer),
			])
		})
	})

	it('unions overlapping provider transitions so each consumer restarts once', async () => {
		await withCoreHost(async (host) => {
			await host.start(OptionalConsumer)
			host.add([OptionalProviderCtor, SecondOptionalProviderCtor])
			const summary = await host.commit()

			expect(consumerStarts).toBe(2)
			expect(new Set(observedGenerations.map((value) => value.split(':')[0]))).toEqual(
				new Set(['first', 'second']),
			)
			expect(summary.pluginChanges.restarted).toEqual([
				host.ctx.registry.resolvePluginNode(OptionalConsumer),
			])
		})
	})
})
