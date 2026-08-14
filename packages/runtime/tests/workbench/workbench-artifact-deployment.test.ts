import { resolve } from 'node:path'
import { sanitizeWorkbenchOwnerName } from '@pluxel/core/federation'
import { describe, expect, it } from 'vitest'
import { workbench } from '@pluxel/runtime/workbench'

import {
	resolveDeploymentWorkbenchManifestPath,
	WorkbenchArtifactService,
} from '../../src/services/workbench/WorkbenchArtifactService.ts'

describe('packaged Workbench artifact deployment paths', () => {
	it('uses the same stable owner directory as the production builder', () => {
		const root = '/tmp/pluxel-static-app/workbench'
		const artifactName = 'artifact-145dcb103f88'

		expect(resolveDeploymentWorkbenchManifestPath(root, artifactName)).toBe(
			resolve(root, sanitizeWorkbenchOwnerName(artifactName), 'mf-manifest.json'),
		)
	})

	it('does not publish a packaged artifact after its owner is disposed', async () => {
		let resolveManifest!: (path: string) => void
		const manifest = new Promise<string>((resolvePromise) => {
			resolveManifest = resolvePromise
		})
		const root = {
			config: { workbenchArtifactResolver: () => manifest },
			logger: { error: () => {} },
		}
		const owner = {
			...root,
			root,
			pluginInfo: { id: 'DisposedPlugin' },
			effects: {
				defer(dispose: () => void) {
					return { dispose }
				},
			},
		}
		const artifacts = new WorkbenchArtifactService(root as never)
		const declaration = (workbench.entry as unknown as (...args: unknown[]) => unknown)(
			import.meta.url,
			'./ui.tsx',
			'artifact-disposed',
		)
		const dispose = artifacts.registerFor(owner as never, declaration as never)

		dispose()
		resolveManifest('/tmp/should-not-be-read/mf-manifest.json')
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))

		expect(artifacts.getCatalog().bundles).toEqual([])
	})
})
