import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { bundleFromJSON } from '@sigstore/bundle'
import { TrustedRoot } from '@sigstore/protobuf-specs'
import { getTrustedRoot } from '@sigstore/tuf'
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProbeInput } from './provenance-worker'

describe('npm provenance verification inside workerd (network integration)', () => {
	let runtime: Miniflare
	let directory: string
	let input: ProbeInput

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'pluxel-market-provenance-'))
		await promisify(execFile)(
			process.execPath,
			[
				'node_modules/wrangler/bin/wrangler.js',
				'deploy',
				'--dry-run',
				'--config',
				'wrangler.provenance.jsonc',
				'--outdir',
				directory,
			],
			{ env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 30_000 },
		)
		const script = await readFile(join(directory, 'provenance-worker.js'), 'utf8')
		runtime = new Miniflare({
			host: '127.0.0.1',
			port: 0,
			workers: [
				{
					config: {
						name: 'provenance-probe',
						compatibilityDate: '2026-11-03',
						compatibilityFlags: ['nodejs_compat'],
						manifest: {
							mainModule: 'worker.mjs',
							modules: { 'worker.mjs': { type: 'esm', contents: script } },
						},
					},
				},
			],
		})
		await runtime.ready
		async function get(url: string) {
			const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
			if (!response.ok) throw new Error(`${response.status} fetching ${url}`)
			return response
		}
		const metadata = (await (await get('https://registry.npmjs.org/capnweb/0.12.0')).json()) as {
			dist: { tarball: string; attestations: { url: string } }
		}
		const [tarball, attestations, trustedRoot] = await Promise.all([
			get(metadata.dist.tarball).then((response) => response.arrayBuffer()),
			get(metadata.dist.attestations.url).then((response) => response.json()),
			getTrustedRoot({ cachePath: join(directory, 'tuf'), retry: 0, timeout: 10_000 }).then(
				(root) => TrustedRoot.toJSON(root),
			),
		])
		const list = attestations as { attestations: { predicateType: string; bundle: unknown }[] }
		const provenance = list.attestations.find(
			(item) => item.predicateType === 'https://slsa.dev/provenance/v1',
		)
		if (!provenance) throw new Error('The fixed npm sample has no provenance')
		input = {
			bundle: provenance.bundle,
			trustedRoot,
			artifact: Buffer.from(tarball).toString('base64'),
			packageName: 'capnweb',
			version: '0.12.0',
		}
	})

	afterAll(async () => {
		try {
			await runtime?.dispose()
		} finally {
			if (directory) await rm(directory, { recursive: true, force: true })
		}
	})

	async function verify(value: ProbeInput) {
		const response = await runtime.dispatchFetch('http://probe/', {
			method: 'POST',
			body: JSON.stringify(value),
		})
		return { status: response.status, body: await response.json() }
	}

	it('accepts the same proof with the native Node verifier', () => {
		const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(input.trustedRoot)))
		expect(() =>
			verifier.verify(toSignedEntity(bundleFromJSON(input.bundle)), {
				extensions: { issuer: 'https://token.actions.githubusercontent.com' },
				subjectAlternativeName:
					'https://github.com/cloudflare/capnweb/.github/workflows/release.yml@refs/heads/main',
			}),
		).not.toThrow()
	})

	it('verifies npm bytes in workerd before checking substitutions', async () => {
		const result = await verify(input)
		expect(result, JSON.stringify(result)).toMatchObject({
			status: 200,
			body: { verified: true, repository: 'https://github.com/cloudflare/capnweb' },
		})
		// Negative checks are meaningful only after the valid sample passes.
		expect(
			await verify({ ...input, artifact: Buffer.from('different artifact').toString('base64') }),
		).toMatchObject({ status: 422, body: { verified: false } })
		for (const changed of [{ packageName: 'different-package' }, { version: '0.12.1' }]) {
			expect(await verify({ ...input, ...changed })).toMatchObject({
				status: 422,
				body: { verified: false },
			})
		}
		const bundle = structuredClone(input.bundle) as { dsseEnvelope: { payload: string } }
		bundle.dsseEnvelope.payload = Buffer.from('{"tampered":true}').toString('base64')
		expect(await verify({ ...input, bundle })).toMatchObject({
			status: 422,
			body: { verified: false },
		})
	})
})
