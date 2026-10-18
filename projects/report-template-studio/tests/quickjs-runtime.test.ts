import { expect, it } from 'vitest'
import { newQuickJSWASMModule } from 'quickjs-emscripten'

it('retains the pending-job context and scratch pointers after WASM memory grows', async () => {
	const quickjs = await newQuickJSWASMModule()
	using vm = quickjs.newContext()
	const before = quickjs.getWasmMemory().buffer.byteLength
	using _promise = vm.unwrapResult(
		vm.evalCode(`Promise.resolve().then(() => {
			const values = []
			for (let i = 0; i < 200000; i++) values.push({ i })
			globalThis.values = values
			return values.length
		})`),
	)
	expect(vm.runtime.executePendingJobs().unwrap()).toBeGreaterThan(0)
	expect(quickjs.getWasmMemory().buffer.byteLength).toBeGreaterThan(before)
	expect(vm.runtime.hasPendingJob()).toBe(false)
	using values = vm.getProp(vm.global, 'values')
	expect(vm.getLength(values)).toBe(200000)
	using names = vm.unwrapResult(vm.getOwnPropertyNames(vm.global))
	expect(names.map((name) => vm.getString(name))).toContain('values')
	using deferred = vm.newPromise()
	deferred.resolve(vm.undefined)
})
