import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSourceOperationLocks } from '../src/source/operation-lock'
import { buildSourceWorkspace, installSourceWorkspace } from '../src/source/execution'
import type { ResolvedSourceCheckout, SourceWorkspacePlan } from '../src/source/plan'

const mocked = vi.hoisted(() => ({ plan: undefined as SourceWorkspacePlan | undefined }))
vi.mock('../src/workspace/dependencies', () => ({
	syncWorkspaceDependencies: async (): Promise<never[]> => [],
}))
vi.mock('../src/workspace/setup', () => ({
	preflightDevelopmentSetup: () => {},
	markDevelopmentIncomplete: () => {},
	setupDevelopmentWorkspace: (): string[] => [],
}))
vi.mock('../src/source/plan', async (original) => ({
	...(await original<typeof import('../src/source/plan')>()),
	createSourceWorkspacePlan: async () => mocked.plan,
}))
const roots: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-operation-'))
	roots.push(root)
	return root
}
async function planFixture() {
	const root = await fixture()
	const bin = resolve(root, 'bin')
	await mkdir(bin)
	await writeFile(resolve(root, 'package.json'), '{}')
	const executable = resolve(bin, 'pnpm')
	await writeFile(
		executable,
		`#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst mode = fs.existsSync('mode') ? fs.readFileSync('mode', 'utf8') : '';\nfs.appendFileSync('operations', process.argv.slice(2).join(' ') + '\\n');\nif (mode === 'fail') process.exit(1);\nsetTimeout(() => { fs.writeFileSync('finished', 'yes'); }, mode === 'slow' ? 400 : 10);\n`,
	)
	await chmod(executable, 0o755)
	vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
	const checkouts: ResolvedSourceCheckout[] = []
	for (const name of ['a', 'b']) {
		const dir = resolve(root, name)
		await mkdir(dir)
		await writeFile(resolve(dir, 'package.json'), '{}')
		const pkg = {
			name,
			dir,
			manifestPath: resolve(dir, 'package.json'),
			manifest: { name, scripts: { build: 'test' }, main: 'dist/index.js' },
		}
		checkouts.push({
			root: dir,
			repository: `https://example.com/${name}`,
			origin: 'registered',
			sources: [],
			singletons: [],
			workspace: {
				root: dir,
				rootManifest: {},
				packages: [pkg],
				packagesByName: new Map([[name, pkg]]),
			},
		})
	}
	const plan: SourceWorkspacePlan = {
		root,
		configPath: 'pluxel.sources.json',
		registryPath: resolve(root, 'registry.json'),
		checkouts,
		selectedPackages: checkouts.flatMap((c) => c.workspace.packages),
		selectedByRepository: new Map(checkouts.map((c) => [c.repository, c.workspace.packages])),
		executionLevels: [checkouts],
		overrides: {},
	}
	mocked.plan = plan
	return plan
}

describe('source operation ownership', () => {
	it('waits across processes sharing providers in opposite input order', async () => {
		const root = await fixture()
		const other = await fixture()
		const release = await acquireSourceOperationLocks([root, other], 'install', () => {})
		const moduleUrl = new URL('../src/source/operation-lock.ts', import.meta.url).href
		const child = spawn(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import { acquireSourceOperationLocks } from ${JSON.stringify(moduleUrl)}; const release = await acquireSourceOperationLocks(${JSON.stringify([other, root])}, 'build', console.log); console.log('ACQUIRED'); release();`,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		)
		let output = ''
		child.stdout.on('data', (chunk) => {
			output += chunk
		})
		const done = new Promise<number | null>((resolveExit, reject) => {
			child.once('error', reject)
			child.once('exit', resolveExit)
		})
		try {
			await vi.waitFor(() => expect(output).toContain('Waiting for source operation'), {
				timeout: 5000,
			})
			expect(output).not.toContain('ACQUIRED')
		} finally {
			release()
		}
		expect(await done).toBe(0)
		expect(output).toContain('ACQUIRED')
		expect(existsSync(resolve(root, '.pluxel/source-operation.lock'))).toBe(false)
	})
	it('drains sibling builds after failure before releasing provider ownership', async () => {
		const plan = await planFixture()
		await writeFile(resolve(plan.checkouts[0]!.root, 'mode'), 'fail')
		await writeFile(resolve(plan.checkouts[1]!.root, 'mode'), 'slow')
		await expect(buildSourceWorkspace({ plan, log: () => {} })).rejects.toThrow('failed in')
		expect(await readFile(resolve(plan.checkouts[1]!.root, 'finished'), 'utf8')).toBe('yes')
		expect(existsSync(resolve(plan.root, '.pluxel/source-operation.lock'))).toBe(false)
		const release = await acquireSourceOperationLocks([plan.root], 'build', () => {})
		release()
	})
	it('builds during install without reacquiring its own graph locks', async () => {
		const plan = await planFixture()
		await installSourceWorkspace({ plan, build: true, frozenLockfile: false, log: () => {} })
		for (const checkout of plan.checkouts) {
			expect(await readFile(resolve(checkout.root, 'operations'), 'utf8')).toContain('run build')
			expect(existsSync(resolve(checkout.root, '.pluxel/source-install.lock'))).toBe(false)
			expect(existsSync(resolve(checkout.root, '.pluxel/source-operation.lock'))).toBe(false)
		}
	})
	it('does not steal an unverifiable lock and releases already acquired roots', async () => {
		const root = await fixture()
		const a = resolve(root, 'a'),
			b = resolve(root, 'b')
		await mkdir(a)
		await mkdir(resolve(b, '.pluxel'), { recursive: true })
		await writeFile(resolve(b, '.pluxel/source-operation.lock'), 'invalid')
		await expect(acquireSourceOperationLocks([b, a], 'build', () => {})).rejects.toThrow(
			'Confirm its previous build/install and child processes have stopped',
		)
		expect(existsSync(resolve(a, '.pluxel/source-operation.lock'))).toBe(false)
		expect(await readFile(resolve(b, '.pluxel/source-operation.lock'), 'utf8')).toBe('invalid')
	})
})
