import { Buffer } from 'node:buffer'
import { bundleFromJSON } from '@sigstore/bundle'
import { TrustedRoot } from '@sigstore/protobuf-specs'
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify'

// Test-only input: callers of a real notification endpoint must never supply trust roots.
export type ProbeInput = {
	bundle: unknown
	trustedRoot: unknown
	artifact: string
	packageName: string
	version: string
}

export default {
	async fetch(request: Request): Promise<Response> {
		try {
			const input: ProbeInput = await request.json()
			const bundle = bundleFromJSON(input.bundle)
			const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(input.trustedRoot)))
			const signer = verifier.verify(toSignedEntity(bundle), {
				extensions: { issuer: 'https://token.actions.githubusercontent.com' },
				subjectAlternativeName:
					'https://github.com/cloudflare/capnweb/.github/workflows/release.yml@refs/heads/main',
			})
			if (bundle.content.$case !== 'dsseEnvelope') throw new Error('Expected DSSE provenance')
			const statement = JSON.parse(
				Buffer.from(bundle.content.dsseEnvelope.payload).toString('utf8'),
			)
			const digest = Buffer.from(
				await crypto.subtle.digest('SHA-512', Buffer.from(input.artifact, 'base64')),
			).toString('hex')
			if (
				statement._type !== 'https://in-toto.io/Statement/v1' ||
				statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
				statement.subject.length !== 1 ||
				statement.subject[0].name !== `pkg:npm/${input.packageName}@${input.version}` ||
				statement.subject[0].digest.sha512 !== digest
			) {
				throw new Error('Provenance does not bind the requested package, version and tarball')
			}
			return Response.json({
				verified: true,
				digest,
				identity: signer.identity,
				repository: statement.predicate.buildDefinition.externalParameters.workflow.repository,
			})
		} catch (error) {
			return Response.json(
				{ verified: false, error: error instanceof Error ? error.message : String(error) },
				{ status: 422 },
			)
		}
	},
} satisfies ExportedHandler
