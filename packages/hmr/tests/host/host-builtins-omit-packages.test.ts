import { describe, expect, it } from 'bun:test'
import { createHmrHost } from '@pluxel/hmr/host'
import { createFixture } from 'fs-fixture'

describe('@pluxel/hmr/host builtins + workspace profiles', () => {
	it('omits builtin packages from snapshot discovery to prevent double-loading', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - builtin-plugins/*', '  - chatbots/*', ''].join(
				'\n',
			),
			'pluxel.hmr.jsonc': [
				'{',
				'  "version": 1,',
				'  "profile": "dev",',
				'  "defaults": { "roots": "auto" },',
				'  "profiles": {',
				'    "dev": {',
				'      "enabled": ["@pluxel/graphql", "pluxel-plugin-bot-suite"]',
				'    }',
				'  }',
				'}',
				'',
			].join('\n'),
			'builtin-plugins/graphql/package.json': JSON.stringify({
				name: '@pluxel/graphql',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'builtin-plugins/graphql/src/index.ts': 'export const plugins = []\n',
			'chatbots/bot-suite/package.json': JSON.stringify({
				name: 'pluxel-plugin-bot-suite',
				version: '0.0.0',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts' } },
			}),
			'chatbots/bot-suite/src/index.ts': 'export const plugins = []\n',
		})

		const prevCwd = process.cwd()
		try {
			const res = await createHmrHost({
				root: fixture.path,
				chdir: false,
				logging: false,
				// builtins must provide packageName so the host can omit the corresponding workspace package.
				builtins: [
					{ plugin: class GraphQL {}, packageName: '@pluxel/graphql', exportKey: 'default' },
				],
			})

			const cfg = (
				res.ctx.root.hmrService as unknown as { config: { roots: string[]; entries: string[] } }
			).config

			expect(cfg.entries).toEqual(['chatbots/bot-suite/src/index.ts'])
			expect(cfg.roots).toEqual(['chatbots/bot-suite'])
		} finally {
			process.chdir(prevCwd)
		}
	})
})
