import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { rolldown } from 'rolldown'
import Macros from 'unplugin-macros/rolldown'

const macroEntrySource = [
	"import { bakeMachine } from '../../defineMachine.macro.ts' with { type: 'macro' }",
	"import { hydrateMachine } from '../../defineMachine.macro.ts'",
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
	"\t\tstates: ['idle', 'running', 'stopped'],",
	"\t\tevents: ['start', 'stop'],",
	"\t\tinit: 'idle',",
	'',
	'\t\ttransitions: [',
	"\t\t\t['idle', 'start', 'running', 'onStart'],",
	"\t\t\t['running', 'stop', 'stopped'],",
	'\t\t],',
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

const macroSourcePath = fileURLToPath(
	new URL('../../../src/internal/fsm/defineMachine.macro.ts', import.meta.url),
)

describe('macro baked fsm', () => {
	test('Rolldown should execute macros and output a usable factory', async () => {
		await using fixture = await createFixture({
			'fsm/tests/fixtures/macro-entry.ts': macroEntrySource,
			'fsm/defineMachine.macro.ts': ({ symlink }) => symlink(macroSourcePath),
		})
		const entry = fixture.getPath('fsm', 'tests', 'fixtures', 'macro-entry.ts')
		const outdir = fixture.getPath('.tmp', 'macro-test')
		const bundle = await rolldown({
			input: entry,
			plugins: [Macros()],
		})
		await bundle.write({
			dir: outdir,
			entryFileNames: 'macro-entry.mjs',
			format: 'esm',
			sourcemap: false,
		})
		await bundle.close()

		const built = resolve(outdir, 'macro-entry.mjs')
		expect(existsSync(built)).toBe(true)

		const mod = await import(pathToFileURL(built).href)
		const { fsm } = mod as { fsm: any }

		expect(typeof fsm.createMachine).toBe('function')
		expect(typeof fsm.createMachineSync).toBe('function')
		expect(fsm.Def.stateCount).toBe(3)
		expect(fsm.Def.eventCount).toBe(2)

		const machine = fsm.createMachine()
		expect(machine.getState()).toBe(fsm.S.idle)

		await machine.dispatch(fsm.E.start, 'job')
		expect(machine.getState()).toBe(fsm.S.running)

		await machine.dispatch(fsm.E.stop)
		expect(machine.getState()).toBe(fsm.S.stopped)
		expect(machine.isFinal()).toBe(true)
	})
})
