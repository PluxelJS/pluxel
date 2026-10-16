import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runDevCommand } from '../src/dev/process'

const directories: string[] = []
const processes: ChildProcess[] = []
const childPids = new Set<number>()
const quote = (value: string) =>
	process.platform === 'win32'
		? `"${value.replaceAll('"', '""')}"`
		: `'${value.replaceAll("'", "'\\''")}'`

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-command-'))
	directories.push(directory)
	return directory
}

afterEach(async () => {
	for (const child of processes.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
	}
	for (const pid of childPids) {
		try {
			process.kill(pid, 'SIGKILL')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
		}
	}
	childPids.clear()
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

describe('foreground dev command', () => {
	it('injects only the child profile and project, inherits environment and cwd, and preserves the exit code', async () => {
		const directory = await fixture()
		const originalProfile = process.env.PLUXEL_DEV_PROFILE
		const originalProject = process.env.PLUXEL_DEV_PROJECT
		await writeFile(
			join(directory, 'command.mjs'),
			`
import { writeFileSync } from 'node:fs';
writeFileSync('result.json', JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, profile: process.env.PLUXEL_DEV_PROFILE, project: process.env.PLUXEL_DEV_PROJECT }));
process.exitCode = 23;`,
		)
		expect(await runDevCommand(`${quote(process.execPath)} command.mjs`, directory, 'app')).toBe(23)
		expect(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))).toEqual({
			cwd: directory,
			home: process.env.HOME,
			profile: 'app',
			project: directory,
		})
		expect(process.env.PLUXEL_DEV_PROFILE).toBe(originalProfile)
		expect(process.env.PLUXEL_DEV_PROJECT).toBe(originalProject)
	})

	it('finds ancestor package binaries, with the nearest package taking precedence', async () => {
		const directory = await fixture()
		const nested = join(directory, 'packages/app')
		await mkdir(nested, { recursive: true })
		const binary = async (root: string, value: string) => {
			const bin = join(root, 'node_modules/.bin')
			await mkdir(bin, { recursive: true })
			const path = join(
				bin,
				process.platform === 'win32' ? 'pluxel-test-bin.cmd' : 'pluxel-test-bin',
			)
			await writeFile(
				path,
				process.platform === 'win32'
					? `@echo ${value}>result.txt\r\n`
					: `#!/bin/sh\nprintf '${value}' > result.txt\n`,
			)
			await chmod(path, 0o755)
		}
		await binary(directory, 'ancestor')
		expect(await runDevCommand('pluxel-test-bin', nested, 'app')).toBe(0)
		const ancestorResult = await readFile(join(nested, 'result.txt'), 'utf8')
		expect(ancestorResult.trim()).toBe('ancestor')
		await binary(nested, 'nearest')
		expect(await runDevCommand('pluxel-test-bin', nested, 'app')).toBe(0)
		const nearestResult = await readFile(join(nested, 'result.txt'), 'utf8')
		expect(nearestResult.trim()).toBe('nearest')
	})

	it('rejects an invalid working directory without retaining signal handlers', async () => {
		const directory = await fixture()
		const before = process.listenerCount('SIGINT')
		await expect(
			runDevCommand('echo unreachable', join(directory, 'absent'), 'app'),
		).rejects.toMatchObject({ code: 'ENOENT' })
		expect(process.listenerCount('SIGINT')).toBe(before)
	})

	it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
		'forwards %s to the real shell child and grandchild, then returns a signal exit code',
		async (signal) => {
			const directory = await fixture()
			const source = fileURLToPath(new URL('../src/dev/process.ts', import.meta.url))
			await writeFile(
				join(directory, 'grandchild.mjs'),
				`
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
 console.log('grandchild:' + signal); process.exit(0);
});
console.log('grandchild-ready:' + process.pid);
setInterval(() => {}, 1000);
`,
			)
			await writeFile(
				join(directory, 'child.mjs'),
				`
import { spawn } from 'node:child_process';
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
 console.log('child:' + signal); process.exit(0);
});
console.log('child-ready:' + process.pid);
spawn(process.execPath, ['grandchild.mjs'], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`,
			)
			await writeFile(
				join(directory, 'runner.mjs'),
				`
import { runDevCommand } from ${JSON.stringify(source)};
process.exitCode = await runDevCommand(${JSON.stringify(`${quote(process.execPath)} child.mjs`)}, process.cwd(), 'app');
`,
			)
			const runner = spawn(process.execPath, ['runner.mjs'], {
				cwd: directory,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			processes.push(runner)
			let output = ''
			let errors = ''
			runner.stderr!.on('data', (data) => {
				errors += data
			})
			const closed = once(runner, 'close')
			await new Promise<void>((resolve, reject) => {
				runner.once('error', reject)
				runner.once('exit', () => reject(new Error(`Runner exited before readiness: ${errors}`)))
				runner.stdout!.on('data', (data) => {
					output += data
					for (const match of output.matchAll(/(?:child|grandchild)-ready:(\d+)/g))
						childPids.add(Number(match[1]))
					if (output.includes('grandchild-ready:')) resolve()
				})
			})
			runner.kill(signal)
			const [code] = await closed
			expect(errors).toBe('')
			expect(code).toBe(signal === 'SIGINT' ? 130 : 143)
			expect(output).toContain(`child:${signal}`)
			expect(output).toContain(`grandchild:${signal}`)
		},
		10_000,
	)
})
