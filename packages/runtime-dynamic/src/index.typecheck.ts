import { startDynamicDevRuntime, type DynamicDevRuntime } from './index.ts'

const ready = startDynamicDevRuntime({
	entry: new URL('./fixtures/pluxel.dynamic.ts', import.meta.url),
})
void ready

declare const runtime: DynamicDevRuntime
const origin: string = runtime.origin
void [origin, runtime.ctx, runtime.dispose(), runtime[Symbol.asyncDispose]()]

// @ts-expect-error The direct launcher is ready on return and has no second-phase start.
runtime.start()
// @ts-expect-error Lifetime ends through dispose, not the former stop method.
runtime.stop()
// @ts-expect-error The canonical module locator is named entry, not config.
startDynamicDevRuntime({ config: './pluxel.dynamic.ts' })
