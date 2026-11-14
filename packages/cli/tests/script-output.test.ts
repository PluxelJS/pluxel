import { afterEach, expect, it, vi } from 'vitest'
import { printFailure, printRun, printRunProgress } from '../src/script/output'

afterEach(() => {
	process.exitCode = 0
	vi.restoreAllMocks()
})

it.each([
	['succeeded', false, 0],
	['failed', false, 1],
	['cancelled', false, 1],
	['cancelling', false, 2],
	['running', true, 0],
])('uses the same execution exit policy for %s (detached %s)', (state, detached, exit) => {
	const output: string[] = []
	const run = { state, value: { status: 'error', error: { code: 'business_failed' } } }
	printRun((text) => output.push(text), 'receipt', run, detached)
	expect(output.map((text) => JSON.parse(text))).toEqual([
		{ ok: true, value: { receipt: 'receipt', run } },
	])
	expect(process.exitCode).toBe(exit)
})

it('retains the original receipt on errors and uses one progress protocol', () => {
	const output: string[] = [],
		events: string[] = []
	vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
		events.push(String(text))
		return true
	})
	printRunProgress('prepared', 'original')
	printRunProgress('accepted', 'original')
	printFailure(
		(text) => output.push(text),
		{ code: 'outcome_unknown', message: 'Disconnected' },
		'original',
	)
	expect(events.map((text) => JSON.parse(text))).toEqual([
		{ stage: 'prepared', receipt: 'original' },
		{ stage: 'accepted', receipt: 'original' },
	])
	expect(output.map((text) => JSON.parse(text))).toEqual([
		{ ok: false, error: { code: 'outcome_unknown', message: 'Disconnected', receipt: 'original' } },
	])
	expect(process.exitCode).toBe(1)
})
