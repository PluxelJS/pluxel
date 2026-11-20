import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { SuperJSON } from 'superjson'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../../scripts/migrate-policy-v7.mjs', import.meta.url))

function migrate({ policy, state, write = false, preload }) {
	const instrumentation = preload
		? ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`]
		: []
	return run(
		process.execPath,
		[
			...instrumentation,
			script,
			'--policy',
			policy,
			'--state',
			state,
			...(write ? ['--write'] : []),
		],
		{ timeout: 10_000 },
	)
}

function node(exportName, forkId) {
	const definition = { entry: { kind: 'package-root', packageName: 'fixture' }, exportName }
	return forkId === undefined
		? { definition, variant: 'default' }
		: { definition, variant: 'fork', forkId }
}

it('previews and preserves v7 choices, then writes only a policy the Host can adopt', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pluxel-policy-migration-'))
	try {
		const policy = join(dir, 'author.json')
		const state = join(dir, 'state.json')
		const main = node('Main')
		const disabled = node('Disabled')
		const east = node('Main', 'east')
		const retired = node('Main', 'retired')
		const notDiscovered = node('Later', 'unavailable')
		const token = node('Token').definition
		await writeFile(
			policy,
			JSON.stringify({
				policy: {
					autoStart: [main],
					forks: [east],
					dependencyOverrides: [
						{ consumerAddress: main, requirementAddress: token, providerAddress: east },
					],
					providerDefaults: [{ token, provider: main }],
					startConcurrency: 3,
					mode: { dependencyOverrides: 'saved-first', startConcurrency: 'saved-first' },
				},
				nodes: [notDiscovered],
			}),
		)
		const legacy = SuperJSON.stringify({
			version: 7,
			autoStart: [disabled],
			forks: [retired],
			dependencyOverrides: [],
			providerDefaults: [],
			startConcurrency: 2,
		})
		await writeFile(state, legacy)
		const previewRun = await migrate({ policy, state })
		const preview = JSON.parse(previewRun.stdout)
		expect(preview).toMatchObject({
			written: false,
			unresolved: [],
			declaration: {
				pluginNodes: expect.arrayContaining([
					{ definition: disabled.definition, autoStart: false },
					expect.objectContaining({
						definition: main.definition,
						autoStart: true,
						forks: { east: { deploy: true } },
					}),
				]),
			},
			document: {
				version: 8,
				autoStart: [{ node: disabled, autoStart: true }],
				forks: [{ node: retired, deploy: false }],
				dependencyOverrides: [
					{ consumerAddress: main, requirementAddress: token, providerAddress: null },
				],
				providerDefaults: [],
				startConcurrency: 2,
			},
			adjustments: [
				{
					field: 'forks',
					layer: 'saved',
					before: { node: retired, deploy: true },
					after: { node: retired, deploy: false },
				},
			],
		})
		expect(preview.comparison).toContainEqual({
			node: notDiscovered,
			before: { deploy: false, autoStart: false, dependencyOverrides: [] },
			after: { deploy: false, autoStart: false, dependencyOverrides: [] },
		})
		expect(preview.global).toContainEqual({ field: 'startConcurrency', before: 2, after: 2 })
		expect(await readFile(state, 'utf8')).toBe(legacy)
		const writeRun = await migrate({ policy, state, write: true })
		expect(JSON.parse(writeRun.stdout)).toEqual({
			...preview,
			written: true,
		})
		expect(SuperJSON.parse(await readFile(state, 'utf8'))).toEqual(preview.document)
		const files = await readdir(dir)
		expect(files.sort()).toEqual(['author.json', 'state.json'])

		const impossible = SuperJSON.stringify({ version: 7, forks: [east] })
		await writeFile(state, impossible)
		await writeFile(policy, JSON.stringify({ policy: { autoStart: [east] } }))
		const failure = await migrate({ policy, state, write: true }).catch((error) => error)
		expect(failure).toMatchObject({ code: 1, stderr: '' })
		const rejected = JSON.parse(failure.stdout)
		expect(rejected.written).toBe(false)
		expect(rejected.unresolved).toContainEqual(expect.objectContaining({ field: 'autoStart' }))
		expect(rejected.comparison).toContainEqual({
			node: east,
			before: { deploy: true, autoStart: true, dependencyOverrides: [] },
			after: { deploy: true, autoStart: false, dependencyOverrides: [] },
		})
		expect(await readFile(state, 'utf8')).toBe(impossible)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}, 20_000)

it('preserves newly written bytes and removes the temporary file when replacement is stale', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pluxel-policy-migration-'))
	try {
		const policy = join(dir, 'author.json')
		const state = join(dir, 'state.json')
		const updated = SuperJSON.stringify({ version: 7, startConcurrency: 3 })
		await writeFile(policy, JSON.stringify({ policy: {} }))
		await writeFile(state, SuperJSON.stringify({ version: 7 }))
		const target = await realpath(state)
		const preload = `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const open = fs.open
fs.open = async (path, flags, mode) => {
	if (path.startsWith(${JSON.stringify(`${target}.`)}) && path.endsWith('.tmp'))
		await fs.writeFile(${JSON.stringify(target)}, ${JSON.stringify(updated)})
	return open(path, flags, mode)
}
syncBuiltinESMExports()
`
		await expect(migrate({ policy, state, write: true, preload })).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('state.json changed while preparing migration'),
		})
		expect(await readFile(state, 'utf8')).toBe(updated)
		const files = await readdir(dir)
		expect(files.sort()).toEqual(['author.json', 'state.json'])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}, 15_000)
