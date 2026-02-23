import { describe, expect, it } from 'vitest'
import { createHmrHost } from '@pluxel/hmr/host'
import { createFixture } from 'fs-fixture'

describe('@pluxel/hmr/host builtinsFromDist', () => {
	it('resolves builtin dist entries and prefers .mjs when available', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - builtin-plugins/*', '  - apps/*', ''].join('\n'),
			'pnpm-lock.yaml': 'lockfileVersion: 9\n',
			'pluxel.hmr.jsonc': [
				'{',
				'  "version": 1,',
				'  "profile": "dev",',
				'  "defaults": { "roots": "auto" },',
				'  "profiles": {',
				'    "dev": {',
				'      "builtin": ["@pluxel/graphql"],',
				'      "enabled": ["pluxel-plugin-app"]',
				'    }',
				'  }',
				'}',
				'',
			].join('\n'),
			'builtin-plugins/graphql/package.json': JSON.stringify({
				name: '@pluxel/graphql',
				version: '0.0.0',
				type: 'module',
				exports: {
					'.': {
						'@pluxel/hmr': './src/index.ts',
						default: './dist/index.js',
						import: './dist/index.mjs',
					},
				},
			}),
			'builtin-plugins/graphql/src/index.ts': 'export const plugins = []\n',
			'builtin-plugins/graphql/dist/index.js': 'export default class GraphQL {}\n',
			'builtin-plugins/graphql/dist/index.mjs': 'export default class GraphQL {}\n',

			'apps/app/package.json': JSON.stringify({
				name: 'pluxel-plugin-app',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'apps/app/src/index.ts': 'export const plugins = []\n',
		})

		const prevCwd = process.cwd()
		try {
			const res = await createHmrHost({
				root: fixture.path,
				chdir: false,
				logging: false,
			})

			const cfg = (
				res.ctx.root.hmrService as unknown as {
					config: { entries: string[]; builtinsFromDist?: Array<{ packageName: string; entry: string }> }
				}
			).config

			expect(cfg.entries).toEqual(['apps/app/src/index.ts'])
			expect(cfg.builtinsFromDist?.map((b) => b.packageName)).toEqual(['@pluxel/graphql'])
			expect(cfg.builtinsFromDist?.[0]?.entry.replace(/\\\\/g, '/')).toMatch(/dist\/index\.mjs$/)
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)

	it('fails fast when builtin package exports no .mjs entry', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - builtin-plugins/*', '  - apps/*', ''].join('\n'),
			'pnpm-lock.yaml': 'lockfileVersion: 9\n',
			'pluxel.hmr.jsonc': [
				'{',
				'  "version": 1,',
				'  "profile": "dev",',
				'  "defaults": { "roots": "auto" },',
				'  "profiles": {',
				'    "dev": {',
				'      "builtin": ["@pluxel/graphql"],',
				'      "enabled": ["pluxel-plugin-app"]',
				'    }',
				'  }',
				'}',
				'',
			].join('\n'),
			'builtin-plugins/graphql/package.json': JSON.stringify({
				name: '@pluxel/graphql',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.js' } },
			}),
			'builtin-plugins/graphql/src/index.ts': 'export const plugins = []\n',
			'builtin-plugins/graphql/dist/index.js': 'export default class GraphQL {}\n',

			'apps/app/package.json': JSON.stringify({
				name: 'pluxel-plugin-app',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'apps/app/src/index.ts': 'export const plugins = []\n',
		})

		const prevCwd = process.cwd()
		try {
			await expect(
				createHmrHost({
					root: fixture.path,
					chdir: false,
					logging: false,
				}),
			).rejects.toThrow(/missing dist \.mjs export entry/i)
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)
})
