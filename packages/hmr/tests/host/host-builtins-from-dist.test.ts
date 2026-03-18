import { createHmrHost } from '@pluxel/hmr/host'
import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

describe('@pluxel/hmr/host builtinsFromDist', () => {
	it('plumbs snapshot.builtinsFromDist into hmrService config', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - builtin-plugins/*', '  - apps/*', ''].join('\n'),
			'builtin-plugins/graphql/package.json': JSON.stringify(
				{
					name: '@pluxel/graphql',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { default: './dist/index.mjs' } },
				},
				null,
				2,
			),
			'builtin-plugins/graphql/dist/index.mjs': 'export default class GraphQL {}\n',
			'apps/app/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-app',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime': './src/index.ts' } },
				},
				null,
				2,
			),
			'apps/app/src/index.ts': 'export const plugins = []\n',
		})

		const prevCwd = process.cwd()
		try {
			const snapshot: HmrWorkspaceSnapshot = {
				activeProfile: 'dev',
				roots: ['apps/app'],
				enabled: ['pluxel-plugin-app'],
				builtinPackages: ['@pluxel/graphql'],
				builtinsFromDist: [
					{ packageName: '@pluxel/graphql', entry: 'builtin-plugins/graphql/dist/index.mjs' },
				],
				enabledEntries: ['apps/app/src/index.ts'],
				includedEntries: [],
				watchRoots: ['apps/app'],
				includeGlobs: [],
				excludeGlobs: [],
			}
			const res = await createHmrHost({
				root: fixture.path,
				chdir: false,
				logging: false,
				workspaceSnapshot: snapshot,
			})

			const cfg = (
				res.hmr as unknown as {
					config: {
						entries: string[]
						builtinsFromDist?: Array<{ packageName: string; entry: string }>
					}
				}
			).config

			expect(cfg.entries).toEqual(['apps/app/src/index.ts'])
			expect(cfg.builtinsFromDist?.map((b) => b.packageName)).toEqual(['@pluxel/graphql'])
			expect(cfg.builtinsFromDist?.[0]?.entry).toBe(
				resolve(fixture.path, 'builtin-plugins/graphql/dist/index.mjs'),
			)
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)
})
