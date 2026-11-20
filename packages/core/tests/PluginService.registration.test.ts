import {
	BasePlugin,
	Plugin,
	definePluginRef,
	createCoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'

it('fails explicitly when a raw runner bypasses semantic lowering', async () => {
	const rawDefinePluginRef = definePluginRef
	@Plugin()
	class RawPlugin extends BasePlugin {}

	await using host = createCoreInternalTestHost()
	expect(() => host.add(RawPlugin)).toThrow(/Plugin declaration was not lowered/)
	expect(() => rawDefinePluginRef<RawPlugin>()).toThrow(/Plugin ref was not lowered/)
})
