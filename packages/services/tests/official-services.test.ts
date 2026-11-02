import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createHost, type HostStartupContext } from '@pluxel/host'
import { resolveContextCapability } from '@pluxel/core/host'
import { getContextRuntimeLogging } from '@pluxel/core/logging/internal'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { createWorkbenchFederationDeploymentInventory } from '@pluxel/core/federation'
import { NodeModuleHost } from '../src/node/token'
import { createNodeModuleDeclaration } from '../src/node/declaration'
import { servicesPreset } from '@pluxel/services/preset'

const startup: HostStartupContext = {
	root: process.cwd(),
	mode: 'test',
	env: {},
	bindings: {},
}

test('standalone deployment root supplies Node artifacts and the default Workbench shell', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-services-'))
	let host: Awaited<ReturnType<typeof createHost>> | undefined
	try {
		await mkdir(resolve(root, 'workbench/public/.vite'), { recursive: true })
		await mkdir(resolve(root, 'workbench/public/assets'), { recursive: true })
		await mkdir(resolve(root, 'artifacts/node'), { recursive: true })
		await writeFile(
			resolve(root, 'workbench/pluxel-workbench-producers.json'),
			JSON.stringify(createWorkbenchFederationDeploymentInventory([])),
		)
		await writeFile(
			resolve(root, 'workbench/public/.vite/manifest.json'),
			JSON.stringify({
				'shell/src/client.tsx': { file: 'assets/deployed-shell.js', isEntry: true },
			}),
		)
		await writeFile(resolve(root, 'workbench/public/assets/deployed-shell.js'), 'export {}')
		await writeFile(resolve(root, 'artifacts/node/example.mjs'), 'export const value = 1')
		host = await createHost({
			plugins: [],
			services: await servicesPreset(
				{
					...startup,
					deployment: { root, target: 'node', delivery: 'standalone', variant: 'workbench' },
				},
				{},
			),
		})
		expect(getContextRuntimeLogging(host.ctx)).toBeUndefined()
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

test.each(['standalone', 'modules'] as const)(
	'uses admitted %s delivery without rereading deployment manifests',
	async (delivery) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-services-deployment-'))
		try {
			await writeFile(resolve(root, 'pluxel-deployment.json'), '{malformed external replacement')
			const services = await servicesPreset(
				{ ...startup, deployment: { root, target: 'node', delivery, variant: 'headless' } },
				{ workbench: false },
			)
			expect(services.length).toBeGreaterThan(0)
			expect(services.some((service) => service.name === 'Workbench')).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)
