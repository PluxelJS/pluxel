// file: test/macro-bake.test.ts
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('macro baked fsm', () => {
	test('bun build should execute macros and output usable factory', async () => {
		const outdir = join(__dirname, '.tmp', 'macro-test')
		const entry = join( __dirname, 'fixtures', 'macro-entry.ts')

		const result = await Bun.build({
			entrypoints: [entry],
			outdir,
			target: 'bun',
			format: 'esm',
			sourcemap: 'none',
			minify: false,
		})

		expect(result.success).toBe(true)

		// Bun.build API is official and returns BuildOutput with status. :contentReference[oaicite:2]{index=2}
		// We assume the output file name follows entry base name.
		const built = join(outdir, 'macro-entry.js')
		expect(existsSync(built)).toBe(true)

		const mod = await import(pathToFileURL(built).href)
		const { fsm } = mod as typeof import('./fixtures/macro-entry')

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
