import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readSourceCheckoutRegistry } from '../src/source/config'
import {
	registerSourceCheckout,
	resolveSourceCheckouts,
	unregisterSourceCheckout,
} from '../src/source/registry'

const repository = 'https://github.com/PluxelJS/pluxel'
const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	)
})

async function createCheckout() {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-source-registry-'))
	temporaryRoots.push(root)
	await write(
		root,
		'package.json',
		JSON.stringify({
			name: 'pluxel',
			private: true,
			repository: { url: `${repository}.git` },
		}),
	)
	await write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
	await mkdir(resolve(root, '.git'))
	await write(root, 'packages/cli/package.json', JSON.stringify({ name: '@pluxel/cli' }))
	await write(root, 'packages/cli/src/cli.ts', '')
	await write(root, 'packages/cli/dist/cli.mjs', '')
	return {
		root,
		registryPath: resolve(root, 'config/source-checkouts.json'),
		moduleUrl: pathToFileURL(resolve(root, 'packages/cli/dist/cli.mjs')).href,
	}
}

async function write(root: string, path: string, contents: string) {
	const target = resolve(root, path)
	await mkdir(dirname(target), { recursive: true })
	await writeFile(target, contents)
}

describe('source checkout discovery', () => {
	it('follows the CLI module symlink and does not create a registry', async () => {
		const { root, registryPath } = await createCheckout()
		const link = resolve(root, 'global-pluxel.mjs')
		await symlink(resolve(root, 'packages/cli/dist/cli.mjs'), link)

		expect(resolveSourceCheckouts(registryPath, pathToFileURL(link).href)).toEqual([
			{ repository, root, origin: 'cli' },
		])
		expect(existsSync(dirname(registryPath))).toBe(false)
	})

	it('recognizes a Git worktree with a .git file', async () => {
		const { root, registryPath, moduleUrl } = await createCheckout()
		await rm(resolve(root, '.git'), { recursive: true })
		await write(root, '.git', 'gitdir: /other/pluxel/.git/worktrees/development\n')
		expect(resolveSourceCheckouts(registryPath, moduleUrl)).toEqual([
			{ repository, root, origin: 'cli' },
		])
	})

	it('gives explicit registration priority and restores discovery after unregister', async () => {
		const { root, registryPath, moduleUrl } = await createCheckout()
		const override = resolve(root, 'another-checkout')
		registerSourceCheckout({
			registryPath,
			repository: `${repository}.git`,
			checkoutRoot: override,
		})
		expect(resolveSourceCheckouts(registryPath, moduleUrl)).toEqual([
			{ repository, root: override, origin: 'registered' },
		])
		expect(unregisterSourceCheckout({ registryPath, repository: `${repository}.git` })).toBe(true)
		expect(readSourceCheckoutRegistry(registryPath).checkouts).toEqual({})
		expect(resolveSourceCheckouts(registryPath, moduleUrl)).toEqual([
			{ repository, root, origin: 'cli' },
		])
		expect(unregisterSourceCheckout({ registryPath, repository })).toBe(false)
	})

	it('does not write a registry when unregistering an implicit checkout', async () => {
		const { registryPath } = await createCheckout()
		expect(unregisterSourceCheckout({ registryPath, repository })).toBe(false)
		expect(existsSync(registryPath)).toBe(false)
	})

	it('does not infer a source checkout from an installed CLI nested inside a checkout', async () => {
		const { root, registryPath } = await createCheckout()
		await write(
			root,
			'node_modules/@pluxel/cli/package.json',
			JSON.stringify({ name: '@pluxel/cli' }),
		)
		await write(root, 'node_modules/@pluxel/cli/dist/cli.mjs', '')
		const moduleUrl = pathToFileURL(resolve(root, 'node_modules/@pluxel/cli/dist/cli.mjs')).href
		expect(resolveSourceCheckouts(registryPath, moduleUrl)).toEqual([])
	})

	it('does not use the calling working directory to discover a checkout', async () => {
		const { root, registryPath } = await createCheckout()
		await write(root, 'ordinary-project/package.json', JSON.stringify({ name: 'ordinary-project' }))
		await write(root, 'ordinary-project/entry.mjs', '')
		const moduleUrl = pathToFileURL(resolve(root, 'ordinary-project/entry.mjs')).href
		// The test runner itself runs inside the real Pluxel checkout.
		expect(resolveSourceCheckouts(registryPath, moduleUrl)).toEqual([])
	})

	it('rejects a matching directory layout without Git metadata', async () => {
		const { root, registryPath, moduleUrl } = await createCheckout()
		await rm(resolve(root, '.git'), { recursive: true })
		expect(resolveSourceCheckouts(registryPath, moduleUrl)).toEqual([])
	})

	it('reports malformed registry configuration even when implicit discovery is available', async () => {
		const { root, registryPath, moduleUrl } = await createCheckout()
		await write(root, 'config/source-checkouts.json', '{"version":2,"checkouts":{}}')
		expect(() => resolveSourceCheckouts(registryPath, moduleUrl)).toThrow('version must be 1')
		expect(() => unregisterSourceCheckout({ registryPath, repository })).toThrow(
			'version must be 1',
		)
	})
})
