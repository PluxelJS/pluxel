import { readDevService, startDevService } from '../src/dev/project'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDevSelection } from '@pluxel/agent-sdk/internal/client'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	for (const dispose of cleanup.splice(0).toReversed()) await dispose()
})

async function workspace(config: unknown = { app: { root: 'web', pitchfork: 'server' } }) {
	const directory = await mkdtemp(resolve(tmpdir(), 'px-project-'))
	cleanup.push(() => rm(directory, { recursive: true, force: true }))
	const root = resolve(directory, 'workspace')
	const web = resolve(root, 'web')
	await mkdir(web, { recursive: true })
	await writeFile(resolve(root, 'package.json'), JSON.stringify({ pluxel: { dev: config } }))
	await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
	return { directory, root, web }
}

async function pitchfork(directory: string) {
	const bin = resolve(directory, 'bin')
	const calls = resolve(directory, 'pitchfork-calls.jsonl')
	await mkdir(bin)
	await writeFile(calls, '')
	await writeFile(
		resolve(bin, 'pitchfork'),
		`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PLUXEL_TEST_PITCHFORK_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'status') {
  process.stdout.write(process.env.PLUXEL_TEST_PITCHFORK_STATUS || JSON.stringify({ id: 'fixture/' + args[1], status: 'running' }));
} else if (args[0] === 'start') {
  process.exitCode = 0;
} else {
  process.exitCode = 1;
}
`,
		{ mode: 0o700 },
	)
	vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
	vi.stubEnv('PLUXEL_TEST_PITCHFORK_CALLS', calls)
	return async (): Promise<Array<{ args: string[]; cwd: string }>> => {
		const output = await readFile(calls, 'utf8')
		return output
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	}
}

describe('Pitchfork development service integration', () => {
	it('starts the resolved full service ID in its declaring package', async () => {
		const project = await workspace()
		const calls = await pitchfork(project.directory)
		const { project: config } = await resolveDevSelection({ root: project.web })
		const service = await readDevService(config)
		expect(await startDevService(config, service)).toBe(0)
		expect(await calls()).toEqual([
			{ args: ['status', 'server', '--json'], cwd: project.root },
			{ args: ['start', 'fixture/server', '--quiet'], cwd: project.root },
		])
	})

	it('rejects Pitchfork output identifying another daemon', async () => {
		const project = await workspace()
		await pitchfork(project.directory)
		vi.stubEnv(
			'PLUXEL_TEST_PITCHFORK_STATUS',
			JSON.stringify({ id: 'fixture/other', status: 'running' }),
		)
		const { project: config } = await resolveDevSelection({ root: project.root })
		await expect(readDevService(config)).rejects.toMatchObject({ code: 'invalid_project' })
	})
})
