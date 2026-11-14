import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { collectHostEvaluatedInputs, hostEnvironment, importHostModule } from '../src/environment'

it('reads the original inputs from the actual cached ModuleRunner source maps', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'pluxel-evaluated-inputs-'))
	const dependency = resolve(directory, 'dependency.ts')
	const entry = resolve(directory, 'entry.ts')
	const original = 'export const value: number = 1\n'
	await writeFile(dependency, original)
	await writeFile(entry, "export { value } from './dependency'\n")
	const server = await createServer({
		root: directory,
		configFile: false,
		plugins: [hostEnvironment()],
		server: { watch: null },
		logLevel: 'silent',
	})
	try {
		expect(await importHostModule(server, entry)).toMatchObject({ value: 1 })
		await writeFile(dependency, 'export const value: number = 2\n')
		expect(await importHostModule(server, entry)).toMatchObject({ value: 1 })
		const inputs = collectHostEvaluatedInputs(server, entry)
		expect(inputs.get(dependency)).toBe(original)
		expect(inputs.get(entry)).toBe("export { value } from './dependency'\n")
	} finally {
		await server.close()
		await rm(directory, { recursive: true, force: true })
	}
})
