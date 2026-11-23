import { readFile, readdir } from 'node:fs/promises'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { repositoryOwner } from '../src/protocol'

it('migrates existing single-source data without losing release identity, receipts or curation revisions', async () => {
	const runtime = new Miniflare({
		host: '127.0.0.1',
		port: 0,
		workers: [
			{
				config: {
					name: 'market-migration-test',
					compatibilityDate: '2026-11-03',
					manifest: {
						mainModule: 'worker.mjs',
						modules: {
							'worker.mjs': {
								type: 'esm',
								contents: 'export default { fetch() { return new Response("migration fixture") } }',
							},
						},
					},
					env: { DB: { type: 'd1', id: 'migration-test' } },
				},
			},
		],
	})
	try {
		await runtime.ready
		const db = await runtime.getD1Database('DB')
		const entries = await readdir(new URL('../migrations/', import.meta.url))
		const files = entries.filter((name) => name.endsWith('.sql')).sort()
		const links = [
			'https://github.com/PluxelJS/pluxel',
			'https://github.com/abc-123/a.b_c-1',
			'https://github.com/bad--account/repo',
			'https://github.com/user-/repo',
			'https://github.com/-user/repo',
			'https://github.com/org/missing/subpage',
			'https://github.com/org/',
			'https://github.com/org/repo?x',
			'https://github.com/org/repo#section',
			'https://user@github.com/org/repo',
			'https://github.com.example/org/repo',
			'https://example.com/org/repo',
			null,
		]
		for (const [index, file] of files.entries()) {
			const source = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
			await db.batch(
				source
					.split('--> statement-breakpoint')
					.filter((statement) => statement.trim())
					.map((statement) => db.prepare(statement)),
			)
			if (index === 0)
				await db.batch([
					db.prepare(
						"INSERT INTO packages(name, description, dist_tags, observed_at, hidden, revision) VALUES ('@example/old', 'Historical transport plugin', '{\"latest\":\"1.0.0\"}', 10, 1, 7)",
					),
					db.prepare(
						"INSERT INTO releases VALUES ('@example/old', '1.0.0', 'https://registry.npmjs.org/old.tgz', 'original-digest', 10, '{\"status\":\"missing\"}', '{}', '{}')",
					),
					db.prepare(
						"INSERT INTO notifications(id, name, version, created_at, updated_at, status, attempts, code) VALUES ('kept-receipt', '@example/old', '1.0.0', 1, 10, 'failed', 1, 'provenance-runtime-unsupported')",
					),
					db.prepare(
						"INSERT INTO audits(id, name, action, revision, at) VALUES ('kept-audit', '@example/old', 'hide', 7, 10)",
					),
				])
			if (file.startsWith('0007_')) {
				await db.batch([
					db.prepare(
						"INSERT INTO market_authors VALUES ('github:128', '@PluxelJS', 'github', 'https://avatars.githubusercontent.com/u/128', 100)",
					),
					db.prepare(
						"INSERT INTO market_authors VALUES ('market:team', 'Manual team', 'market', NULL, 100)",
					),
					db
						.prepare(
							"UPDATE packages SET repository = ?, repository_author_id = 'github:128', curated_author_id = 'market:team', repository_stars = 42, repository_observed_at = 100 WHERE name = '@example/old'",
						)
						.bind(links[0]!),
					...links.map((link, n) =>
						db
							.prepare(
								"INSERT INTO packages (name, dist_tags, observed_at, repository, curated_author_id) VALUES (?, '{}', 20, ?, 'market:team')",
							)
							.bind('fixture-' + n, link),
					),
				])
			}
		}
		expect(
			await db
				.prepare(
					"SELECT registry, name, hidden, revision, official, tags, repository_owner, repository_avatar_url, repository_stars FROM packages WHERE name = '@example/old'",
				)
				.first(),
		).toEqual({
			registry: 'https://registry.npmjs.org',
			name: '@example/old',
			hidden: 1,
			revision: 7,
			official: 0,
			tags: '[]',
			repository_owner: 'PluxelJS',
			repository_avatar_url: 'https://avatars.githubusercontent.com/u/128',
			repository_stars: 42,
		})
		const converted = await db
			.prepare("SELECT name, repository_owner FROM packages WHERE name GLOB 'fixture-*'")
			.all<{ name: string; repository_owner: string | null }>()
		expect(
			Object.fromEntries(converted.results.map((row) => [row.name, row.repository_owner])),
		).toEqual(Object.fromEntries(links.map((link, n) => ['fixture-' + n, repositoryOwner(link)])))
		expect(await db.prepare('SELECT registry, integrity FROM releases').first()).toEqual({
			registry: 'https://registry.npmjs.org',
			integrity: 'original-digest',
		})
		expect(
			await db
				.prepare('SELECT registry, id, status, attempts, github_publisher FROM notifications')
				.first(),
		).toEqual({
			registry: 'https://registry.npmjs.org',
			id: 'kept-receipt',
			status: 'failed',
			attempts: 1,
			github_publisher: null,
		})
		expect(await db.prepare('SELECT registry, id, revision FROM audits').first()).toEqual({
			registry: 'https://registry.npmjs.org',
			id: 'kept-audit',
			revision: 7,
		})
		const constraints = await db.prepare('PRAGMA foreign_key_check').all()
		expect(constraints.results).toEqual([])
		expect(
			await db
				.prepare("SELECT name FROM package_search WHERE package_search MATCH 'transport'")
				.first(),
		).toEqual({ name: '@example/old' })
	} finally {
		await runtime.dispose()
	}
}, 30_000)
