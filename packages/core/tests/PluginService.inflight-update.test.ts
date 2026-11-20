import { BasePlugin, Plugin, createCoreInternalTestHost } from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'
import * as v from 'valibot'
import { lowerTestReplacement } from './lowered-replacement'

const configSchema = v.object({ value: v.number() })
let enteredInit: ReturnType<typeof Promise.withResolvers<void>>
let finishInit: ReturnType<typeof Promise.withResolvers<void>>

@Plugin()
class ConfiguredProvider extends BasePlugin {
	readonly config = this.configs.use(configSchema)

	override async init() {
		enteredInit.resolve()
		await finishInit.promise
	}
}

class Replacement extends ConfiguredProvider {}

it('rejects concurrent edits and applies later configuration only in the next generation', async () => {
	lowerTestReplacement(ConfiguredProvider, Replacement, {
		config: { fieldName: 'config', schema: configSchema },
	})
	enteredInit = Promise.withResolvers()
	finishInit = Promise.withResolvers()
	await using host = createCoreInternalTestHost()
	const config = host.cfg(ConfiguredProvider)
	config.set({ value: 1 })
	host.add(ConfiguredProvider)

	const starting = host.commit()
	try {
		await enteredInit.promise
		config.set({ value: 2 })
		for (const edit of [
			() => host.restart(ConfiguredProvider),
			() => host.replace(ConfiguredProvider, Replacement),
			() => host.remove(ConfiguredProvider),
		]) {
			expect(edit).toThrow(/another update is active/i)
		}
	} finally {
		finishInit.resolve()
		await starting
	}
	const original = host.require(ConfiguredProvider)
	expect(original.config.value).toBe(1)

	host.restart(ConfiguredProvider)
	await host.commit()
	const next = host.require(ConfiguredProvider)
	expect(next).not.toBe(original)
	expect(next.config.value).toBe(2)
})
