import { expect, it, vi } from 'vitest'
import { build, type TsdownBundle } from 'tsdown'
import { runWithTsdown } from '../src/cli/tsdown-runner'

vi.mock('tsdown', async (importOriginal) => ({
	...(await importOriginal<typeof import('tsdown')>()),
	build: vi.fn(),
}))

it('cleans every acquired bundle on hook failure and retains cleanup failures', async () => {
	const failure = new Error('success hook failed')
	const cleanupFailure = new Error('cleanup failed')
	const first = vi.fn(async () => {
		throw cleanupFailure
	})
	const second = vi.fn(async () => {})
	vi.mocked(build).mockResolvedValue({
		bundles: [
			{ config: {}, [Symbol.asyncDispose]: first },
			{ config: {}, [Symbol.asyncDispose]: second },
		] as unknown as TsdownBundle[],
		watch: { close: vi.fn(), restart: vi.fn() },
	})
	const result = runWithTsdown({
		context: {
			projectRoot: process.cwd(),
			packageJsonPath: 'package.json',
			manifestField: 'pluxel',
			watch: false,
			debug: false,
		},
		log: () => {},
		onSuccess: async () => {
			throw failure
		},
	})
	await expect(result).rejects.toMatchObject({ cause: failure, errors: [failure, cleanupFailure] })
	expect(first).toHaveBeenCalledOnce()
	expect(second).toHaveBeenCalledOnce()
})

it('settles one-shot hooks before releasing every bundle', async () => {
	const order: string[] = []
	vi.mocked(build).mockResolvedValue({
		bundles: [
			{
				config: {},
				async [Symbol.asyncDispose]() {
					order.push('dispose')
				},
			},
		] as unknown as TsdownBundle[],
		watch: { close: vi.fn(), restart: vi.fn() },
	})
	await expect(
		runWithTsdown({
			context: {
				projectRoot: process.cwd(),
				packageJsonPath: 'package.json',
				manifestField: 'pluxel',
				watch: false,
				debug: false,
			},
			log: () => {},
			onSuccess: async () => {
				await Promise.resolve()
				order.push('hook')
			},
		}),
	).resolves.toBeUndefined()
	expect(order).toEqual(['hook', 'dispose'])
})

it('leaves native watch controls and success hooks with the CLI process', async () => {
	const dispose = vi.fn()
	const close = vi.fn()
	const restart = vi.fn()
	const hook = vi.fn()
	vi.mocked(build).mockResolvedValue({
		bundles: [{ config: {}, [Symbol.asyncDispose]: dispose }] as unknown as TsdownBundle[],
		watch: { close, restart },
	})
	await runWithTsdown({
		context: {
			projectRoot: process.cwd(),
			packageJsonPath: 'package.json',
			manifestField: 'pluxel',
			watch: true,
			debug: false,
		},
		log: () => {},
		onSuccess: hook,
	})
	expect(build).toHaveBeenLastCalledWith(
		expect.objectContaining({ watch: true, onSuccess: expect.any(Function) }),
	)
	expect(hook).not.toHaveBeenCalled()
	expect(dispose).not.toHaveBeenCalled()
	expect(close).not.toHaveBeenCalled()
	expect(restart).not.toHaveBeenCalled()
})
