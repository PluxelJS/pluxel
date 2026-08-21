import {
	createHash,
	createPublicKey,
	KeyObject,
	randomBytes,
	verify as verifySignature,
} from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import {
	assertExactFields,
	assertSortedUniqueEntries,
	collectDistributionEntries,
	compareDistributionEntries,
	DELIVERY_MARKER_FILE,
	DISTRIBUTION_ENVELOPE_FILE,
	DISTRIBUTION_MANIFEST_FILE,
	DistributionFilesystemError,
	isPathInside,
	readExactRecord,
	validateManifestEntry,
} from './filesystem'
import type {
	DeliveryCorrelationReportV1,
	DeliveryMarkerV1,
	DeliveryRecordV1,
	DistributionInspectionReportV1,
	DistributionReleaseClaims,
	DistributionStatementV1,
	DistributionVerificationCode,
	DistributionVerificationReportV1,
	DsseEnvelope,
	DsseSignature,
	PluxelArtifactSetV1,
} from './types'

export type * from './types'
export {
	DELIVERY_MARKER_FILE,
	DISTRIBUTION_ENVELOPE_FILE,
	DISTRIBUTION_MANIFEST_FILE,
} from './filesystem'

export const DISTRIBUTION_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1' as const
export const DISTRIBUTION_PREDICATE_TYPE =
	'https://pluxel.dev/attestations/distribution/v1' as const
export const DISTRIBUTION_DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const

export type TrustedDistributionKey = string | Buffer | KeyObject

type DeploymentFacts = Readonly<{
	name: string
	catalogHash: string
	variant: 'headless' | 'workbench'
}>

class DistributionUnsupportedError extends Error {
	override readonly name = 'DistributionUnsupportedError'
}

export async function createDistributionManifest(rootInput: string): Promise<PluxelArtifactSetV1> {
	const root = resolve(rootInput)
	const facts = await readDeploymentFacts(root)
	const manifest: PluxelArtifactSetV1 = {
		schemaVersion: 1,
		kind: 'pluxel-artifact-set',
		producer: {
			kind: 'static-application',
			target: 'node',
			variant: facts.variant,
		},
		application: { name: facts.name, catalogHash: facts.catalogHash },
		entries: await collectDistributionEntries(root),
	}
	await writeFileAtomic(resolve(root, DISTRIBUTION_MANIFEST_FILE), serializeJson(manifest))
	return manifest
}

export async function inspectDistribution(
	rootInput: string,
): Promise<DistributionInspectionReportV1> {
	const root = resolve(rootInput)
	const manifestBytes = await readOptionalFile(resolve(root, DISTRIBUTION_MANIFEST_FILE))
	if (!manifestBytes) return inspectionReport('MANIFEST_ABSENT')

	let manifest: PluxelArtifactSetV1
	try {
		manifest = parseDistributionManifest(manifestBytes)
		await assertManifestDeploymentFacts(root, manifest)
	} catch {
		return inspectionReport('MANIFEST_INVALID', {
			manifestSha256: sha256(manifestBytes),
		})
	}

	try {
		const differences = compareDistributionEntries(
			manifest.entries,
			await collectDistributionEntries(root),
		)
		return inspectionReport(differences.length === 0 ? 'INTACT' : 'ARTIFACT_MISMATCH', {
			differences,
			manifestSha256: sha256(manifestBytes),
			manifest,
		})
	} catch (error) {
		if (!(error instanceof DistributionFilesystemError)) throw error
		return inspectionReport('ARTIFACT_MISMATCH', {
			differences: [{ kind: 'unsupported', path: error.path, observed: error.message }],
			manifestSha256: sha256(manifestBytes),
			manifest,
		})
	}
}

function parseDistributionManifest(bytes: Uint8Array): PluxelArtifactSetV1 {
	const source = decodeUtf8(bytes, 'distribution manifest')
	const value = readExactRecord(parseJson(source, 'distribution manifest'), 'distribution manifest')
	assertExactFields(
		value,
		['schemaVersion', 'kind', 'producer', 'application', 'entries'],
		'distribution manifest',
	)
	if (value.schemaVersion !== 1 || value.kind !== 'pluxel-artifact-set') {
		throw new TypeError('distribution manifest schemaVersion or kind is unsupported')
	}
	const producer = readExactRecord(value.producer, 'distribution manifest.producer')
	assertExactFields(producer, ['kind', 'target', 'variant'], 'distribution manifest.producer')
	if (
		producer.kind !== 'static-application' ||
		producer.target !== 'node' ||
		(producer.variant !== 'headless' && producer.variant !== 'workbench')
	) {
		throw new TypeError('distribution manifest producer is unsupported')
	}
	const application = readExactRecord(value.application, 'distribution manifest.application')
	assertExactFields(application, ['name', 'catalogHash'], 'distribution manifest.application')
	if (typeof application.name !== 'string' || !application.name.trim()) {
		throw new TypeError('distribution manifest application.name must be a non-empty string')
	}
	if (
		typeof application.catalogHash !== 'string' ||
		!/^[0-9a-f]{64}$/.test(application.catalogHash)
	) {
		throw new TypeError('distribution manifest application.catalogHash must be a SHA-256 digest')
	}
	if (!Array.isArray(value.entries))
		throw new TypeError('distribution manifest entries must be an array')
	const manifest: PluxelArtifactSetV1 = {
		schemaVersion: 1,
		kind: 'pluxel-artifact-set',
		producer: {
			kind: 'static-application',
			target: 'node',
			variant: producer.variant,
		},
		application: { name: application.name, catalogHash: application.catalogHash },
		entries: value.entries.map((entry, index) =>
			validateManifestEntry(entry, `distribution manifest.entries[${index}]`),
		),
	}
	assertSortedUniqueEntries(manifest.entries)
	if (!Buffer.from(serializeJson(manifest)).equals(Buffer.from(bytes))) {
		throw new TypeError('distribution manifest is not in canonical v1 encoding')
	}
	return manifest
}

export function readDistributionReleaseClaims(value: unknown): DistributionReleaseClaims {
	const claims = readExactRecord(value, 'release claims')
	const fields = ['version', 'revision', 'distributionId'] as const
	const allowed = new Set<string>(fields)
	const unknown = Object.getOwnPropertyNames(claims).filter((field) => !allowed.has(field))
	if (unknown.length > 0)
		throw new TypeError(`release claims contains unsupported field ${unknown[0]}`)
	const output: { version?: string; revision?: string; distributionId?: string } = {}
	for (const field of fields) {
		const claimValue = claims[field]
		if (claimValue === undefined) continue
		output[field] = readClaim(
			claimValue,
			`release claims.${field}`,
			field === 'distributionId' ? 16 : 1,
		)
	}
	if (Object.keys(output).length === 0) {
		throw new TypeError('release claims must contain version, revision, or distributionId')
	}
	return Object.freeze(output) as DistributionReleaseClaims
}

export function createDistributionStatement(
	manifestBytes: Uint8Array,
	claimsInput: DistributionReleaseClaims,
): Uint8Array {
	const claims = readDistributionReleaseClaims(claimsInput)
	const statement: DistributionStatementV1 = {
		_type: DISTRIBUTION_STATEMENT_TYPE,
		subject: [
			{
				name: DISTRIBUTION_MANIFEST_FILE,
				digest: { sha256: sha256(manifestBytes) },
			},
		],
		predicateType: DISTRIBUTION_PREDICATE_TYPE,
		predicate: claims,
	}
	return Buffer.from(serializeJson(statement))
}

export function createDssePreAuthenticationEncoding(
	payloadType: string,
	payload: Uint8Array,
): Uint8Array {
	const type = Buffer.from(payloadType)
	const body = Buffer.from(payload)
	return Buffer.concat([
		Buffer.from(`DSSEv1 ${type.byteLength} `),
		type,
		Buffer.from(` ${body.byteLength} `),
		body,
	])
}

export function createDistributionDsseEnvelope(
	statementBytes: Uint8Array,
	signaturesInput: readonly [DsseSignature, ...DsseSignature[]],
): DsseEnvelope {
	parseDistributionStatement(statementBytes)
	if (!Array.isArray(signaturesInput) || signaturesInput.length === 0) {
		throw new TypeError('DSSE envelope must contain at least one signature')
	}
	const signatures = signaturesInput.map((signature, index) =>
		readDsseSignature(signature, `DSSE signatures[${index}]`),
	) as [DsseSignature, ...DsseSignature[]]
	return Object.freeze({
		payloadType: DISTRIBUTION_DSSE_PAYLOAD_TYPE,
		payload: Buffer.from(statementBytes).toString('base64'),
		signatures: Object.freeze(signatures),
	})
}

export function serializeDistributionDsseEnvelope(envelope: DsseEnvelope): Uint8Array {
	const parsed = parseDistributionDsseEnvelope(Buffer.from(serializeJson(envelope)))
	return Buffer.from(serializeJson(parsed.envelope))
}

export function fingerprintDistributionKey(keyInput: TrustedDistributionKey): string {
	const key = toPublicKey(keyInput)
	const der = key.export({ type: 'spki', format: 'der' })
	return `sha256:${createHash('sha256').update(der).digest('base64url')}`
}

export async function verifyDistribution(
	rootInput: string,
	trustedKeysInput: readonly TrustedDistributionKey[],
): Promise<DistributionVerificationReportV1> {
	const root = resolve(rootInput)
	const manifestBytes = await readOptionalFile(resolve(root, DISTRIBUTION_MANIFEST_FILE))
	if (!manifestBytes) return verificationReport('MANIFEST_ABSENT')
	const observedManifestSha256 = sha256(manifestBytes)
	const envelopeBytes = await readOptionalFile(resolve(root, DISTRIBUTION_ENVELOPE_FILE))
	if (!envelopeBytes) {
		return verificationReport('ATTESTATION_ABSENT', { observedManifestSha256 })
	}

	let parsedEnvelope: ReturnType<typeof parseDistributionDsseEnvelope>
	let statement: DistributionStatementV1
	try {
		parsedEnvelope = parseDistributionDsseEnvelope(envelopeBytes)
		statement = parseDistributionStatement(parsedEnvelope.payload)
	} catch (error) {
		return verificationReport(
			error instanceof DistributionUnsupportedError
				? 'ATTESTATION_UNSUPPORTED'
				: 'ATTESTATION_INVALID',
			{ observedManifestSha256 },
		)
	}

	const signedManifestSha256 = statement.subject[0]!.digest.sha256
	const signatureResult = verifyTrustedSignatures(parsedEnvelope, trustedKeysInput)
	if (signatureResult.code !== 'VERIFIED') {
		return verificationReport(signatureResult.code, {
			observedManifestSha256,
			signedManifestSha256,
			claims: statement.predicate,
		})
	}
	if (signedManifestSha256 !== observedManifestSha256) {
		return verificationReport('SUBJECT_MISMATCH', {
			observedManifestSha256,
			signedManifestSha256,
			claims: statement.predicate,
			trustedKeyFingerprint: signatureResult.fingerprint,
		})
	}

	let manifest: PluxelArtifactSetV1
	try {
		manifest = parseDistributionManifest(manifestBytes)
		await assertManifestDeploymentFacts(root, manifest)
	} catch {
		return verificationReport('MANIFEST_INVALID', {
			observedManifestSha256,
			signedManifestSha256,
			claims: statement.predicate,
			trustedKeyFingerprint: signatureResult.fingerprint,
		})
	}

	try {
		const differences = compareDistributionEntries(
			manifest.entries,
			await collectDistributionEntries(root),
		)
		return verificationReport(differences.length === 0 ? 'VERIFIED' : 'ARTIFACT_MISMATCH', {
			differences,
			observedManifestSha256,
			signedManifestSha256,
			claims: statement.predicate,
			trustedKeyFingerprint: signatureResult.fingerprint,
		})
	} catch (error) {
		if (!(error instanceof DistributionFilesystemError)) throw error
		return verificationReport('ARTIFACT_MISMATCH', {
			differences: [{ kind: 'unsupported', path: error.path, observed: error.message }],
			observedManifestSha256,
			signedManifestSha256,
			claims: statement.predicate,
			trustedKeyFingerprint: signatureResult.fingerprint,
		})
	}
}

export async function markDistribution(options: {
	root: string
	claims: DistributionReleaseClaims & Readonly<{ distributionId: string }>
	recordOut: string
}): Promise<DeliveryRecordV1> {
	const root = resolve(options.root)
	const claims = readDistributionReleaseClaims(options.claims)
	if (!claims.distributionId) throw new TypeError('delivery marker requires claims.distributionId')
	const recordOut = await resolveOutputOutsideRoot(root, resolve(options.recordOut))
	const token = randomBytes(32).toString('base64url')
	const marker: DeliveryMarkerV1 = {
		schemaVersion: 1,
		kind: 'pluxel-delivery-marker',
		token,
	}
	const record: DeliveryRecordV1 = {
		schemaVersion: 1,
		kind: 'pluxel-delivery-record',
		distributionId: claims.distributionId,
		token,
	}
	await writeNewFile(recordOut, serializeJson(record))
	try {
		await writeNewFile(resolve(root, DELIVERY_MARKER_FILE), serializeJson(marker))
	} catch (error) {
		await rm(recordOut, { force: true }).catch((): undefined => undefined)
		throw error
	}
	return Object.freeze(record)
}

export async function correlateDistribution(options: {
	root: string
	deliveryRecord: DeliveryRecordV1
}): Promise<DeliveryCorrelationReportV1> {
	const markerBytes = await readOptionalFile(resolve(options.root, DELIVERY_MARKER_FILE))
	if (!markerBytes) return Object.freeze({ reportVersion: 1, code: 'DELIVERY_MARK_NONE' })
	const marker = parseDeliveryMarker(markerBytes)
	const record = readDeliveryRecord(options.deliveryRecord)
	return Object.freeze({
		reportVersion: 1,
		code: marker.token === record.token ? 'DELIVERY_MARK_MATCH' : 'DELIVERY_MARK_NONE',
	})
}

export function readDeliveryRecord(value: unknown): DeliveryRecordV1 {
	const record = readExactRecord(value, 'delivery record')
	assertExactFields(record, ['schemaVersion', 'kind', 'distributionId', 'token'], 'delivery record')
	if (record.schemaVersion !== 1 || record.kind !== 'pluxel-delivery-record') {
		throw new TypeError('delivery record schemaVersion or kind is unsupported')
	}
	const distributionId = readClaim(record.distributionId, 'delivery record.distributionId', 16)
	const token = readToken(record.token, 'delivery record.token')
	return Object.freeze({
		schemaVersion: 1,
		kind: 'pluxel-delivery-record',
		distributionId,
		token,
	})
}

function parseDistributionDsseEnvelope(bytes: Uint8Array): {
	envelope: DsseEnvelope
	payload: Uint8Array
} {
	const value = readExactRecord(
		parseJson(decodeUtf8(bytes, 'DSSE envelope'), 'DSSE envelope'),
		'DSSE envelope',
	)
	assertExactFields(value, ['payloadType', 'payload', 'signatures'], 'DSSE envelope')
	if (value.payloadType !== DISTRIBUTION_DSSE_PAYLOAD_TYPE) {
		throw new DistributionUnsupportedError('DSSE payload type is unsupported')
	}
	const payload = readCanonicalBase64(value.payload, 'DSSE envelope.payload')
	if (!Array.isArray(value.signatures) || value.signatures.length === 0) {
		throw new TypeError('DSSE envelope.signatures must be a non-empty array')
	}
	const signatures = value.signatures.map((signature, index) =>
		readDsseSignature(signature, `DSSE envelope.signatures[${index}]`),
	) as [DsseSignature, ...DsseSignature[]]
	return {
		envelope: Object.freeze({
			payloadType: DISTRIBUTION_DSSE_PAYLOAD_TYPE,
			payload: Buffer.from(payload).toString('base64'),
			signatures: Object.freeze(signatures),
		}),
		payload,
	}
}

function parseDistributionStatement(bytes: Uint8Array): DistributionStatementV1 {
	const value = readExactRecord(
		parseJson(decodeUtf8(bytes, 'in-toto statement'), 'in-toto statement'),
		'in-toto statement',
	)
	assertExactFields(value, ['_type', 'subject', 'predicateType', 'predicate'], 'in-toto statement')
	if (value._type !== DISTRIBUTION_STATEMENT_TYPE) {
		throw new DistributionUnsupportedError('in-toto statement type is unsupported')
	}
	if (value.predicateType !== DISTRIBUTION_PREDICATE_TYPE) {
		throw new DistributionUnsupportedError('distribution predicate type is unsupported')
	}
	if (!Array.isArray(value.subject) || value.subject.length !== 1) {
		throw new TypeError('in-toto statement must contain exactly one subject')
	}
	const subject = readExactRecord(value.subject[0], 'in-toto statement.subject[0]')
	assertExactFields(subject, ['name', 'digest'], 'in-toto statement.subject[0]')
	if (subject.name !== DISTRIBUTION_MANIFEST_FILE) {
		throw new TypeError(`in-toto subject name must be ${DISTRIBUTION_MANIFEST_FILE}`)
	}
	const digest = readExactRecord(subject.digest, 'in-toto statement.subject[0].digest')
	assertExactFields(digest, ['sha256'], 'in-toto statement.subject[0].digest')
	if (typeof digest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(digest.sha256)) {
		throw new TypeError('in-toto subject digest must contain a lowercase SHA-256 digest')
	}
	return Object.freeze({
		_type: DISTRIBUTION_STATEMENT_TYPE,
		subject: Object.freeze([
			Object.freeze({
				name: DISTRIBUTION_MANIFEST_FILE,
				digest: Object.freeze({ sha256: digest.sha256 }),
			}),
		] as const),
		predicateType: DISTRIBUTION_PREDICATE_TYPE,
		predicate: readDistributionReleaseClaims(value.predicate),
	})
}

function verifyTrustedSignatures(
	parsed: ReturnType<typeof parseDistributionDsseEnvelope>,
	trustedKeysInput: readonly TrustedDistributionKey[],
):
	| { code: 'VERIFIED'; fingerprint: string }
	| { code: 'ATTESTATION_UNSUPPORTED' | 'ATTESTATION_INVALID' | 'SIGNATURE_UNTRUSTED' } {
	const trustedKeys = trustedKeysInput.map((input) => {
		const key = toPublicKey(input)
		return { key, fingerprint: fingerprintDistributionKey(key) }
	})
	const pae = createDssePreAuthenticationEncoding(DISTRIBUTION_DSSE_PAYLOAD_TYPE, parsed.payload)
	let candidateFound = false
	let supportedCandidateFound = false
	let unsupportedCandidateFound = false
	for (const signature of parsed.envelope.signatures) {
		const candidates = signature.keyid
			? trustedKeys.filter((candidate) => candidate.fingerprint === signature.keyid)
			: trustedKeys
		if (candidates.length === 0) continue
		candidateFound = true
		const signatureBytes = readCanonicalBase64(signature.sig, 'DSSE signature')
		for (const candidate of candidates) {
			if (candidate.key.asymmetricKeyType !== 'ed25519') {
				unsupportedCandidateFound = true
				continue
			}
			supportedCandidateFound = true
			if (verifySignature(null, pae, candidate.key, signatureBytes)) {
				return { code: 'VERIFIED', fingerprint: candidate.fingerprint }
			}
		}
	}
	if (!candidateFound) return { code: 'SIGNATURE_UNTRUSTED' }
	if (!supportedCandidateFound && unsupportedCandidateFound) {
		return { code: 'ATTESTATION_UNSUPPORTED' }
	}
	return { code: 'ATTESTATION_INVALID' }
}

async function readDeploymentFacts(root: string): Promise<DeploymentFacts> {
	const source = await readFile(resolve(root, 'pluxel-deployment.json'))
	const deployment = readExactRecord(
		parseJson(decodeUtf8(source, 'deployment manifest'), 'deployment manifest'),
		'deployment manifest',
	)
	if (deployment.version !== 1 || deployment.kind !== 'pluxel-static-application') {
		throw new TypeError('deployment manifest is not a Pluxel static application v1')
	}
	const application = readExactRecord(deployment.application, 'deployment manifest.application')
	const name = application.name
	const catalogHash = application.catalogHash
	if (typeof name !== 'string' || !name.trim()) {
		throw new TypeError('deployment manifest application.name must be a non-empty string')
	}
	if (typeof catalogHash !== 'string' || !/^[0-9a-f]{64}$/.test(catalogHash)) {
		throw new TypeError('deployment manifest application.catalogHash must be a SHA-256 digest')
	}
	const server = readExactRecord(deployment.server, 'deployment manifest.server')
	if (server.target !== 'node')
		throw new TypeError('deployment manifest server.target must be node')
	const capabilities = readExactRecord(deployment.capabilities, 'deployment manifest.capabilities')
	const workbench = readExactRecord(
		capabilities.workbench,
		'deployment manifest.capabilities.workbench',
	)
	if (typeof workbench.included !== 'boolean') {
		throw new TypeError('deployment manifest workbench.included must be a boolean')
	}
	return {
		name,
		catalogHash,
		variant: workbench.included ? 'workbench' : 'headless',
	}
}

async function assertManifestDeploymentFacts(
	root: string,
	manifest: PluxelArtifactSetV1,
): Promise<void> {
	const facts = await readDeploymentFacts(root)
	if (
		manifest.application.name !== facts.name ||
		manifest.application.catalogHash !== facts.catalogHash ||
		manifest.producer.target !== 'node' ||
		manifest.producer.variant !== facts.variant
	) {
		throw new TypeError('distribution manifest does not match deployment facts')
	}
}

function parseDeliveryMarker(bytes: Uint8Array): DeliveryMarkerV1 {
	const value = readExactRecord(
		parseJson(decodeUtf8(bytes, 'delivery marker'), 'delivery marker'),
		'delivery marker',
	)
	assertExactFields(value, ['schemaVersion', 'kind', 'token'], 'delivery marker')
	if (value.schemaVersion !== 1 || value.kind !== 'pluxel-delivery-marker') {
		throw new TypeError('delivery marker schemaVersion or kind is unsupported')
	}
	return Object.freeze({
		schemaVersion: 1,
		kind: 'pluxel-delivery-marker',
		token: readToken(value.token, 'delivery marker.token'),
	})
}

function readDsseSignature(value: unknown, label: string): DsseSignature {
	const signature = readExactRecord(value, label)
	assertExactFields(signature, ['keyid', 'sig'], label)
	if (typeof signature.keyid !== 'string' || signature.keyid.length > 200) {
		throw new TypeError(`${label}.keyid must be a string of at most 200 characters`)
	}
	readCanonicalBase64(signature.sig, `${label}.sig`)
	return Object.freeze({ keyid: signature.keyid, sig: String(signature.sig) })
}

function readCanonicalBase64(value: unknown, label: string): Uint8Array {
	if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be base64`)
	const decoded = Buffer.from(value, 'base64')
	if (decoded.toString('base64') !== value)
		throw new TypeError(`${label} must use canonical base64`)
	return decoded
}

function readToken(value: unknown, label: string): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
		throw new TypeError(`${label} must be a 256-bit unpadded base64url token`)
	}
	const decoded = Buffer.from(value, 'base64url')
	if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
		throw new TypeError(`${label} must be a canonical 256-bit unpadded base64url token`)
	}
	return value
}

function readClaim(value: unknown, label: string, minimum: number): string {
	if (typeof value !== 'string' || value.length < minimum || value.length > 300) {
		throw new TypeError(`${label} length must be between ${minimum} and 300 characters`)
	}
	if (value.trim() !== value || hasControlCharacters(value)) {
		throw new TypeError(`${label} must not contain surrounding whitespace or control characters`)
	}
	return value
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
	}
	return false
}

function toPublicKey(input: TrustedDistributionKey): KeyObject {
	if (input instanceof KeyObject) {
		if (input.type !== 'public') {
			throw new TypeError('trusted distribution keys must be public keys')
		}
		return input
	}
	const encoded = typeof input === 'string' ? input : input.toString('utf8')
	if (/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(encoded)) {
		throw new TypeError('trusted distribution keys must be public keys')
	}
	return createPublicKey(input)
}

function inspectionReport(
	code: DistributionInspectionReportV1['code'],
	fields: Omit<Partial<DistributionInspectionReportV1>, 'reportVersion' | 'ok' | 'code'> = {},
): DistributionInspectionReportV1 {
	return Object.freeze({
		reportVersion: 1,
		ok: code === 'INTACT',
		code,
		differences: fields.differences ?? [],
		...(fields.manifestSha256 ? { manifestSha256: fields.manifestSha256 } : {}),
		...(fields.manifest ? { manifest: fields.manifest } : {}),
	})
}

function verificationReport(
	code: DistributionVerificationCode,
	fields: Omit<
		Partial<DistributionVerificationReportV1>,
		'reportVersion' | 'verifierVersion' | 'code'
	> = {},
): DistributionVerificationReportV1 {
	return Object.freeze({
		reportVersion: 1,
		verifierVersion: 1,
		code,
		differences: fields.differences ?? [],
		...(fields.observedManifestSha256
			? { observedManifestSha256: fields.observedManifestSha256 }
			: {}),
		...(fields.signedManifestSha256 ? { signedManifestSha256: fields.signedManifestSha256 } : {}),
		...(fields.claims ? { claims: fields.claims } : {}),
		...(fields.trustedKeyFingerprint
			? { trustedKeyFingerprint: fields.trustedKeyFingerprint }
			: {}),
	})
}

async function readOptionalFile(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

async function writeNewFile(path: string, source: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, source, { encoding: 'utf8', flag: 'wx' })
}

async function resolveOutputOutsideRoot(root: string, output: string): Promise<string> {
	if (isPathInside(root, output)) {
		throw new TypeError('delivery record must be written outside the distribution root')
	}
	await mkdir(dirname(output), { recursive: true })
	const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(output))])
	if (isPathInside(realRoot, realParent)) {
		throw new TypeError('delivery record must be written outside the distribution root')
	}
	return resolve(realParent, basename(output))
}

async function writeFileAtomic(path: string, source: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
	try {
		await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' })
		await rename(temporary, path)
	} finally {
		await rm(temporary, { force: true }).catch((): undefined => undefined)
	}
}

function serializeJson(value: unknown): string {
	return `${JSON.stringify(value)}\n`
}

function sha256(value: Uint8Array): string {
	return createHash('sha256').update(value).digest('hex')
}

function decodeUtf8(value: Uint8Array, label: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(value)
	} catch {
		throw new TypeError(`${label} must be valid UTF-8`)
	}
}

function parseJson(source: string, label: string): unknown {
	try {
		return JSON.parse(source) as unknown
	} catch {
		throw new TypeError(`${label} must be valid JSON`)
	}
}
