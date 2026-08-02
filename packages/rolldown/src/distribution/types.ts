export type DistributionFileEntry = Readonly<{
	path: string
	type: 'file'
	size: number
	sha256: string
}>

export type DistributionSymlinkEntry = Readonly<{
	path: string
	type: 'symlink'
	target: string
}>

export type DistributionEntry = DistributionFileEntry | DistributionSymlinkEntry

export type PluxelArtifactSetV1 = Readonly<{
	schemaVersion: 1
	kind: 'pluxel-artifact-set'
	producer: Readonly<{
		kind: 'static-application'
		target: 'node'
		variant: 'headless' | 'workbench'
	}>
	application: Readonly<{
		name: string
		catalogHash: string
	}>
	entries: readonly DistributionEntry[]
}>

export type DistributionReleaseClaims = Readonly<
	| { version: string; revision?: string; distributionId?: string }
	| { version?: string; revision: string; distributionId?: string }
	| { version?: string; revision?: string; distributionId: string }
>

export type DistributionStatementV1 = Readonly<{
	_type: 'https://in-toto.io/Statement/v1'
	subject: readonly [
		Readonly<{
			name: 'pluxel-distribution.json'
			digest: Readonly<{ sha256: string }>
		}>,
	]
	predicateType: 'https://pluxel.dev/attestations/distribution/v1'
	predicate: DistributionReleaseClaims
}>

export type DsseSignature = Readonly<{
	keyid: string
	sig: string
}>

export type DsseEnvelope = Readonly<{
	payloadType: 'application/vnd.in-toto+json'
	payload: string
	signatures: readonly [DsseSignature, ...DsseSignature[]]
}>

export type DistributionDifference = Readonly<{
	kind: 'missing' | 'unexpected' | 'changed' | 'symlink-target' | 'unsupported'
	path: string
	expected?: string
	observed?: string
}>

export type DistributionVerificationCode =
	| 'VERIFIED'
	| 'MANIFEST_ABSENT'
	| 'MANIFEST_INVALID'
	| 'ATTESTATION_ABSENT'
	| 'ATTESTATION_UNSUPPORTED'
	| 'ATTESTATION_INVALID'
	| 'SIGNATURE_UNTRUSTED'
	| 'SUBJECT_MISMATCH'
	| 'ARTIFACT_MISMATCH'

export type DistributionInspectionReportV1 = Readonly<{
	reportVersion: 1
	ok: boolean
	code: 'INTACT' | 'MANIFEST_ABSENT' | 'MANIFEST_INVALID' | 'ARTIFACT_MISMATCH'
	differences: readonly DistributionDifference[]
	manifestSha256?: string
	manifest?: PluxelArtifactSetV1
}>

export type DistributionVerificationReportV1 = Readonly<{
	reportVersion: 1
	verifierVersion: 1
	code: DistributionVerificationCode
	differences: readonly DistributionDifference[]
	observedManifestSha256?: string
	signedManifestSha256?: string
	claims?: DistributionReleaseClaims
	trustedKeyFingerprint?: string
}>

export type DeliveryMarkerV1 = Readonly<{
	schemaVersion: 1
	kind: 'pluxel-delivery-marker'
	token: string
}>

export type DeliveryRecordV1 = Readonly<{
	schemaVersion: 1
	kind: 'pluxel-delivery-record'
	distributionId: string
	token: string
}>

export type DeliveryCorrelationReportV1 = Readonly<{
	reportVersion: 1
	code: 'DELIVERY_MARK_MATCH' | 'DELIVERY_MARK_NONE'
}>
