import { ProtectedPlugin, type ConfigInput } from './.protected-out/protected-bindings.js'
const accepted: ConfigInput<typeof ProtectedPlugin> = { payload: { raw: '42' } }
void accepted
// @ts-expect-error Input cannot be normalized output.
const rejected: ConfigInput<typeof ProtectedPlugin> = { payload: 42 }
void rejected
// @ts-expect-error Output has mandatory defaulted mode.
const badOutput: ReturnType<ProtectedPlugin['read']> = { payload: 2 }
void badOutput
import { envBinding, EmptyPlugin, ErasedPlugin } from './.protected-out/protected-bindings.js'
envBinding(ProtectedPlugin, { config: { mode: 'APP_MODE', payload: { raw: 'APP_RAW' } } })
envBinding(ProtectedPlugin, { config: {/* config-completion */} })
envBinding(ProtectedPlugin, { config: { payload: {/* payload-completion */} } })
// @ts-expect-error Missing declaration cannot bind config, even using whole-object JSON input.
envBinding(EmptyPlugin, { config: 'APP_CONFIG' })
// @ts-expect-error Erasing the schema brand fails closed.
envBinding(ErasedPlugin, { config: { mode: 'APP_MODE' } })
// @ts-expect-error Invalid input field is rejected rather than inferred into schema.
envBinding(ProtectedPlugin, { config: { payload: { length: 'APP_LENGTH' } } })
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const cleanBusinessKeys: Equal<keyof ReturnType<ProtectedPlugin['read']>, 'mode' | 'payload'> = true
void cleanBusinessKeys
