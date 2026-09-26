import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createHost, type HostStartupContext } from '@pluxel/host'
import { resolveContextCapability } from '@pluxel/core/host'
import { Logging } from '@pluxel/services/logging'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { VaultAdmin } from '@pluxel/services/vault'
import { createWorkbenchFederationDeploymentInventory } from '@pluxel/core/federation'
import { Management } from '@pluxel/services/management/service'
import { parseVaultAdminState } from '@pluxel/services/management/internal/test'
import { NodeModuleHost } from '../src/node/token'
import { createNodeModuleDeclaration } from '../src/node/declaration'
import { servicesPreset } from '@pluxel/services/preset'

const startup: HostStartupContext = {
	root: process.cwd(),
	mode: 'test',
	env: {},
	bindings: {},
}

test('disabled Workbench retains prepared management and vault and releases logging on close', async () => {
	const host = await createHost({
		plugins: [],
		services: await servicesPreset(startup, {
			persistence: { mode: 'memory' },
			workbench: false,
		}),
	})
	const logging = resolveContextCapability(host.ctx, Logging)
	try {
		expect(logging.state).toBe('installed')
		expect(resolveContextCapability(host.ctx, Management)).toBeDefined()
		expect(resolveContextCapability(host.ctx, VaultAdmin)).toBeDefined()
		const vault = await resolveContextCapability(host.ctx, VaultAdmin).describe()
		expect(parseVaultAdminState(vault)).toEqual(vault)
		expect('workbench' in host.ctx).toBe(false)
		const response = await resolveContextCapability(host.ctx, ElysiaRuntime).fetch(
			new Request('http://localhost/__pluxel/workbench', { headers: { accept: 'text/html' } }),
		)
		expect(response.status).toBe(404)
	} finally {
		await host.close()
	}
	expect(logging.state).toBe('disposed')
})

test('deployment root supplies Node artifacts and the default Workbench shell', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-services-'))
	let host: Awaited<ReturnType<typeof createHost>> | undefined
	try {
		await mkdir(resolve(root, 'workbench/public/.vite'), { recursive: true })
		await mkdir(resolve(root, 'artifacts/node'), { recursive: true })
		await writeFile(
			resolve(root, 'workbench/pluxel-workbench-producers.json'),
			JSON.stringify(createWorkbenchFederationDeploymentInventory([])),
		)
		await writeFile(
			resolve(root, 'workbench/public/.vite/manifest.json'),
			JSON.stringify({
				'client.tsx': { file: 'assets/deployed-shell.js', isEntry: true },
			}),
		)
		await writeFile(resolve(root, 'artifacts/node/example.mjs'), 'export const value = 1')
		host = await createHost({
			plugins: [],
			services: await servicesPreset(
				{
					...startup,
					deployment: { root, target: 'node', variant: 'workbench' },
				},
				{ persistence: { mode: 'memory' } },
			),
		})
		const response = await resolveContextCapability(host.ctx, ElysiaRuntime).fetch(
			new Request('http://localhost/__pluxel/workbench', { headers: { accept: 'text/html' } }),
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('assets/deployed-shell.js')
		let artifactPath = ''
		let cleaned = false
		await resolveContextCapability(host.ctx, NodeModuleHost).use(
			createNodeModuleDeclaration(import.meta.url, './example.ts', 'example', 'defineNodeModule'),
			(url) => {
				artifactPath = fileURLToPath(url)
				return () => {
					cleaned = true
				}
			},
		)
		expect(artifactPath).toBe(resolve(root, 'artifacts/node/example.mjs'))
		await host.close()
		expect(cleaned).toBe(true)
		host = undefined
	} finally {
		await host?.close()
		await rm(root, { recursive: true, force: true })
	}
})
