import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('chokidar', () => ({ watch: vi.fn() }))
import { watch } from 'chokidar'
import { createHostDependencyWatch } from '../src/dependency-watch'

beforeEach(() => vi.mocked(watch).mockReset())

it('releases a failed observer and retries the same dependency set', async () => {
	const failed = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	const repaired = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	vi.mocked(watch)
		.mockReturnValueOnce(failed as never)
		.mockReturnValueOnce(repaired as never)
	const owner = createHostDependencyWatch({ onChange: async () => {}, onError: vi.fn() })
	const failure = new Error('WATCH_STARTUP_FAILED')
	const opening = owner.replace(['/app.mjs'])
	failed.emit('error', failure)
	await expect(opening).rejects.toBe(failure)
	expect(owner.covers('/app.mjs')).toBe(false)
	expect(failed.close).toHaveBeenCalledOnce()
	const retry = owner.replace(['/app.mjs'])
	repaired.emit('ready')
	await retry
	expect(watch).toHaveBeenCalledTimes(2)
	expect(owner.covers('/app.mjs')).toBe(true)
	await owner.close()
	expect(repaired.close).toHaveBeenCalledOnce()
})

it('keeps the accepted observer live when an expanded dependency set cannot open', async () => {
	const accepted = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	const failed = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	vi.mocked(watch)
		.mockReturnValueOnce(accepted as never)
		.mockReturnValueOnce(failed as never)
	const onChange = vi.fn(async () => {})
	const owner = createHostDependencyWatch({ onChange, onError: vi.fn() })
	const initial = owner.replace(['/app.mjs'])
	accepted.emit('ready')
	await initial
	const failure = new Error('WATCH_STARTUP_FAILED')
	const replacement = owner.replace(['/app.mjs', '/dependency.mjs'])
	failed.emit('error', failure)
	await expect(replacement).rejects.toBe(failure)
	expect(owner.covers('/app.mjs')).toBe(true)
	expect(owner.covers('/dependency.mjs')).toBe(false)
	expect(accepted.close).not.toHaveBeenCalled()
	accepted.emit('change', '/app.mjs')
	await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('/app.mjs', 'update'))
	await owner.close()
	expect(accepted.close).toHaveBeenCalledOnce()
	expect(failed.close).toHaveBeenCalledOnce()
})

it('closes both accepted and acquiring observers without waiting for a late ready event', async () => {
	const accepted = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	const candidate = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	vi.mocked(watch)
		.mockReturnValueOnce(accepted as never)
		.mockReturnValueOnce(candidate as never)
	const onChange = vi.fn(async () => {})
	const owner = createHostDependencyWatch({ onChange, onError: vi.fn() })
	const initial = owner.replace(['/app.mjs'])
	accepted.emit('ready')
	await initial
	const replacement = owner.replace(['/app.mjs', '/dependency.mjs'])
	await owner.close()
	await replacement
	expect(owner.covers('/app.mjs')).toBe(false)
	expect(owner.covers('/dependency.mjs')).toBe(false)
	expect(accepted.close).toHaveBeenCalledOnce()
	expect(candidate.close).toHaveBeenCalledOnce()
	candidate.emit('ready')
	candidate.emit('change', '/dependency.mjs')
	await Promise.resolve()
	expect(onChange).not.toHaveBeenCalled()
})
