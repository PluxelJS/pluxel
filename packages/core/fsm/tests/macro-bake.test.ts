// file: test/macro-bake.test.ts
import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'

const macroEntrySource = [
	"import { bakeMachine } from '../../defineMachine.macro' with { type: 'macro' }",
	"import { hydrateMachine } from '../../defineMachine.macro'",
	'',
	'export function onStart(name: string) {',
	'\t// no-op',
	'}',
	'',
	'export function onEnterRunning(info: { signal?: AbortSignal }) {',
	'\tconst { signal } = info',
	'\tif (!signal) return',
	'',
	'\tconst t = setInterval(() => {}, 5)',
	"\tsignal.addEventListener('abort', () => clearInterval(t), { once: true })",
	'}',
	'',
	'const impl = {',
	'\tcallbacks: { onStart },',
	'\thooks: { onEnterRunning },',
	'}',
	'',
	'export const fsm = hydrateMachine(',
	'\tbakeMachine({',
	"\t\tstates: ['idle', 'running', 'stopped'] as const,",
	"\t\tevents: ['start', 'stop'] as const,",
	"\t\tinit: 'idle',",
	'',
	'\t\ttransitions: [',
	"\t\t\t['idle', 'start', 'running', 'onStart'],",
	"\t\t\t['running', 'stop', 'stopped'],",
	'\t\t] as const,',
	'',
	'\t\thooks: {',
	"\t\t\tenter: { running: 'onEnterRunning' },",
	'\t\t},',
	'',
	'\t\tabortOnStateChange: true,',
	'\t}),',
	'\timpl,',
	')',
	'',
].join('\n')

const macroSourcePath = fileURLToPath(new URL('../defineMachine.macro.ts', import.meta.url))
const hasBun = (() => {
	try {
		execFileSync('bun', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
})()

describe('macro baked fsm', () => {
	const bunTest = hasBun ? test : test.skip
	bunTest('bun build should execute macros and output usable factory', async () => {
		await using fixture = await createFixture({
			'fsm/tests/fixtures/macro-entry.ts': macroEntrySource,
			'fsm/defineMachine.macro.ts': ({ symlink }) => symlink(macroSourcePath),
		})
		const entry = fixture.getPath('fsm', 'tests', 'fixtures', 'macro-entry.ts')
		const outdir = fixture.getPath('.tmp', 'macro-test')

		const ok = await new Promise<boolean>((resolveOk, reject) => {
			const child = spawn(
				'bun',
				[
					'build',
					entry,
					'--outdir',
					outdir,
					'--target',
					'bun',
					'--format',
					'esm',
					'--sourcemap=none',
				],
				{ stdio: 'inherit' },
			)
			child.on('error', reject)
			child.on('exit', (code) => resolveOk(code === 0))
		})
		expect(ok).toBe(true)

		// Bun.build API is official and returns BuildOutput with status. :contentReference[oaicite:2]{index=2}
		// We assume the output file name follows entry base name.
		const built = resolve(outdir, 'macro-entry.js')
		expect(existsSync(built)).toBe(true)

		const mod = await import(pathToFileURL(built).href)
		const { fsm } = mod as { fsm: any }

		// basic shape checks
		expect(typeof fsm.createMachine).toBe('function')
		expect(typeof fsm.createMachineSync).toBe('function')
		expect(fsm.Def.stateCount).toBe(3)
		expect(fsm.Def.eventCount).toBe(2)

		// runtime behavior checks
		const m = fsm.createMachine()
		expect(m.getState()).toBe(fsm.S.idle)

		await m.dispatch(fsm.E.start, 'job')
		expect(m.getState()).toBe(fsm.S.running)

		await m.dispatch(fsm.E.stop)
		expect(m.getState()).toBe(fsm.S.stopped)
		expect(m.isFinal()).toBe(true)
	})
})
