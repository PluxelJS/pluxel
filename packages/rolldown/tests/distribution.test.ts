import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	createDistributionDsseEnvelope,
	createDistributionManifest,
	createDistributionStatement,
	createDssePreAuthenticationEncoding,
	correlateDistribution,
	DISTRIBUTION_DSSE_PAYLOAD_TYPE,
	DISTRIBUTION_ENVELOPE_FILE,
	DISTRIBUTION_MANIFEST_FILE,
	fingerprintDistributionKey,
	inspectDistribution,
	markDistribution,
	readDeliveryRecord,
	serializeDistributionDsseEnvelope,
	verifyDistribution,
} from '@pluxel/rolldown/distribution'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('@pluxel/rolldown/distribution', () => {
	it('creates a byte-identical manifest and compares the complete artifact set', async () => {
		const root = await createFixture()
		await writeFile(join(root, 'app.mjs'), 'export const app = true\n')
		await writeFile(join(root, 'empty'), '')
		await symlink('app.mjs', join(root, 'current-app'))

		const first = await createDistributionManifest(root)
		const firstBytes = await readFile(join(root, DISTRIBUTION_MANIFEST_FILE))
		const second = await createDistributionManifest(root)
		const secondBytes = await readFile(join(root, DISTRIBUTION_MANIFEST_FILE))

		expect(second).toEqual(first)
		expect(secondBytes).toEqual(firstBytes)
		expect(first.entries.map((entry) => entry.path)).toEqual([
			'app.mjs',
			'current-app',
			'empty',
			'pluxel-deployment.json',
		])
		await expect(inspectDistribution(root)).resolves.toMatchObject({
			ok: true,
			code: 'INTACT',
			differences: [],
		})

		await writeFile(join(root, 'app.mjs'), 'export const app = false\n')
		await expect(inspectDistribution(root)).resolves.toMatchObject({
			ok: false,
			code: 'ARTIFACT_MISMATCH',
			differences: [expect.objectContaining({ kind: 'changed', path: 'app.mjs' })],
		})
	})

	it('rejects escaping and circular symlinks', async () => {
		const escaping = await createFixture()
		await symlink('../outside', join(escaping, 'escape'))
		await expect(createDistributionManifest(escaping)).rejects.toThrow('escapes')

		const circular = await createFixture()
		await symlink('loop', join(circular, 'loop'))
		await expect(createDistributionManifest(circular)).rejects.toThrow('cycle')
	})

	it.runIf(process.platform !== 'win32')('rejects portable case-fold path collisions', async () => {
		const root = await createFixture()
		await writeFile(join(root, 'Artifact'), 'a')
		await writeFile(join(root, 'artifact'), 'b')
		await expect(createDistributionManifest(root)).rejects.toThrow('case-insensitive')
	})

	it.runIf(process.platform !== 'win32')('rejects special filesystem entries', async () => {
		const root = await createFixture()
		const socketPath = join(root, 'runtime.sock')
		const server = createServer()
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(socketPath, resolve)
		})
		try {
			await expect(createDistributionManifest(root)).rejects.toThrow('unsupported filesystem entry')
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	it('verifies a real Ed25519 DSSE signature and reports stable failure codes', async () => {
		const root = await createFixture()
		await writeFile(join(root, 'app.mjs'), 'export const app = true\n')
		await createDistributionManifest(root)
		const manifestPath = join(root, DISTRIBUTION_MANIFEST_FILE)
		const manifestBytes = await readFile(manifestPath)
		const claims = {
			version: '1.4.0',
			revision: '8f91d22',
			distributionId: '01J00000000000000000000000',
		}
		const statement = createDistributionStatement(manifestBytes, claims)
		const { publicKey, privateKey } = generateKeyPairSync('ed25519')
		const keyid = fingerprintDistributionKey(publicKey)
		const signature = sign(
			null,
			createDssePreAuthenticationEncoding(DISTRIBUTION_DSSE_PAYLOAD_TYPE, statement),
			privateKey,
		).toString('base64')
		const envelope = createDistributionDsseEnvelope(statement, [{ keyid, sig: signature }])
		await writeFile(
			join(root, DISTRIBUTION_ENVELOPE_FILE),
			serializeDistributionDsseEnvelope(envelope),
		)

		await expect(verifyDistribution(root, [publicKey])).resolves.toMatchObject({
			code: 'VERIFIED',
			claims,
			trustedKeyFingerprint: keyid,
		})
		expect(() => fingerprintDistributionKey(privateKey)).toThrow(
			'trusted distribution keys must be public keys',
		)
		const stranger = generateKeyPairSync('ed25519').publicKey
		await expect(verifyDistribution(root, [stranger])).resolves.toMatchObject({
			code: 'SIGNATURE_UNTRUSTED',
		})

		await writeFile(manifestPath, Buffer.concat([manifestBytes, Buffer.from('\n')]))
		await expect(verifyDistribution(root, [publicKey])).resolves.toMatchObject({
			code: 'SUBJECT_MISMATCH',
		})
		await writeFile(manifestPath, manifestBytes)
		await writeFile(join(root, 'app.mjs'), 'tampered\n')
		await expect(verifyDistribution(root, [publicKey])).resolves.toMatchObject({
			code: 'ARTIFACT_MISMATCH',
			differences: [expect.objectContaining({ kind: 'changed', path: 'app.mjs' })],
		})
	})

	it('distinguishes invalid signatures from unsupported trusted key algorithms', async () => {
		const root = await createFixture()
		await writeFile(join(root, 'app.mjs'), 'export const app = true\n')
		await createDistributionManifest(root)
		const manifestBytes = await readFile(join(root, DISTRIBUTION_MANIFEST_FILE))
		const statement = createDistributionStatement(manifestBytes, { version: '1.0.0' })
		const ed25519 = generateKeyPairSync('ed25519')
		const ed25519Keyid = fingerprintDistributionKey(ed25519.publicKey)
		await writeFile(
			join(root, DISTRIBUTION_ENVELOPE_FILE),
			serializeDistributionDsseEnvelope(
				createDistributionDsseEnvelope(statement, [
					{ keyid: ed25519Keyid, sig: Buffer.alloc(64).toString('base64') },
				]),
			),
		)
		await expect(verifyDistribution(root, [ed25519.publicKey])).resolves.toMatchObject({
			code: 'ATTESTATION_INVALID',
		})

		const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
		const rsaKeyid = fingerprintDistributionKey(rsa.publicKey)
		const rsaSignature = sign(
			'sha256',
			createDssePreAuthenticationEncoding(DISTRIBUTION_DSSE_PAYLOAD_TYPE, statement),
			rsa.privateKey,
		).toString('base64')
		await writeFile(
			join(root, DISTRIBUTION_ENVELOPE_FILE),
			serializeDistributionDsseEnvelope(
				createDistributionDsseEnvelope(statement, [{ keyid: rsaKeyid, sig: rsaSignature }]),
			),
		)
		await expect(verifyDistribution(root, [rsa.publicKey])).resolves.toMatchObject({
			code: 'ATTESTATION_UNSUPPORTED',
		})
	})

	it('creates one inert delivery marker and correlates only token equality', async () => {
		const root = await createFixture()
		const privateRoot = await createTemporaryRoot('pluxel-private-')
		const recordOut = join(privateRoot, 'delivery-record.json')
		const record = await markDistribution({
			root,
			claims: { distributionId: '01J00000000000000000000000' },
			recordOut,
		})
		await createDistributionManifest(root)

		await expect(correlateDistribution({ root, deliveryRecord: record })).resolves.toEqual({
			reportVersion: 1,
			code: 'DELIVERY_MARK_MATCH',
		})
		await expect(
			correlateDistribution({
				root,
				deliveryRecord: { ...record, token: 'A'.repeat(43) },
			}),
		).resolves.toEqual({ reportVersion: 1, code: 'DELIVERY_MARK_NONE' })
		await expect(
			correlateDistribution({
				root,
				deliveryRecord: { ...record, token: `${'A'.repeat(42)}B` },
			}),
		).rejects.toThrow('canonical 256-bit')
		await expect(
			markDistribution({
				root,
				claims: { distributionId: record.distributionId },
				recordOut,
			}),
		).rejects.toThrow('EEXIST')
		expect(() => readDeliveryRecord({ ...record, manifestSha256: 'a'.repeat(64) })).toThrow(
			'unsupported field manifestSha256',
		)
	})

	it.runIf(process.platform !== 'win32')(
		'rejects private delivery record paths that alias into the distribution',
		async () => {
			const root = await createFixture()
			const privateRoot = await createTemporaryRoot('pluxel-private-alias-')
			const alias = join(privateRoot, 'distribution')
			await symlink(root, alias, 'dir')
			await expect(
				markDistribution({
					root,
					claims: { distributionId: '01J00000000000000000000000' },
					recordOut: join(alias, 'delivery-record.json'),
				}),
			).rejects.toThrow('outside the distribution root')
		},
	)
})

async function createFixture(): Promise<string> {
	const root = await createTemporaryRoot('pluxel-distribution-')
	await writeFile(
		join(root, 'pluxel-deployment.json'),
		`${JSON.stringify({
			version: 1,
			kind: 'pluxel-static-application',
			application: { name: 'fixture', catalogHash: 'a'.repeat(64) },
			server: { entry: 'app.mjs', runtimeClosure: 'bundled', target: 'node' },
			capabilities: {
				nodeModules: { root: 'artifacts/node', artifacts: [] },
				workbench: { included: false, publicRoot: null, artifacts: [] },
			},
			residualDependencies: { mode: 'bundle', packages: [] },
		})}\n`,
	)
	return root
}

async function createTemporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix))
	roots.push(root)
	return root
}
