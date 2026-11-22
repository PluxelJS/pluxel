import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { MarketError, type GitHubNotificationPublisher } from './protocol'
import type { GitHubPublisher } from './sources'

const issuer = 'https://token.actions.githubusercontent.com'
const keys = createRemoteJWKSet(new URL('/.well-known/jwks', issuer), { timeoutDuration: 5000 })

const denied = () =>
	new MarketError(
		'github-oidc-invalid',
		'A valid GitHub Actions OIDC bearer token for this market is required',
		401,
	)

export async function authorizeGitHubNotification(
	request: Request,
	publishers: readonly GitHubPublisher[],
): Promise<GitHubNotificationPublisher> {
	const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(
		request.headers.get('Authorization') ?? '',
	)?.[1]
	if (!token || token.length > 8192) throw denied()
	const audience = new URL('/v1/notifications', request.url).href
	const { payload } = await jwtVerify(token, keys, {
		issuer,
		audience,
		algorithms: ['RS256'],
		requiredClaims: ['exp'],
		maxTokenAge: '5m',
		clockTolerance: 5,
	}).catch((cause: unknown) => {
		if (
			cause instanceof errors.JWTClaimValidationFailed ||
			cause instanceof errors.JWTExpired ||
			cause instanceof errors.JWTInvalid ||
			cause instanceof errors.JWSInvalid ||
			cause instanceof errors.JWSSignatureVerificationFailed ||
			cause instanceof errors.JWKSNoMatchingKey ||
			cause instanceof errors.JOSEAlgNotAllowed ||
			cause instanceof errors.JOSENotSupported
		)
			throw denied()
		throw new MarketError(
			'github-oidc-unavailable',
			'GitHub Actions signing keys are unavailable',
			503,
			true,
		)
	})
	const { run_id: runId, run_attempt: runAttempt } = payload
	if (
		payload.aud !== audience ||
		typeof runId !== 'string' ||
		!/^[1-9]\d{0,19}$/.test(runId) ||
		typeof runAttempt !== 'string' ||
		!/^[1-9]\d{0,9}$/.test(runAttempt)
	)
		throw denied()
	const publisher = publishers.find(
		(rule) =>
			payload.repository_id === rule.repositoryId &&
			payload.repository_owner_id === rule.repositoryOwnerId &&
			payload.workflow_ref === rule.workflowRef &&
			payload.ref === rule.workflowRef.split('@')[1] &&
			(rule.jobWorkflowRef === undefined || payload.job_workflow_ref === rule.jobWorkflowRef),
	)
	if (
		!publisher ||
		!['push', 'workflow_dispatch', 'release'].some((event) => event === payload.event_name)
	) {
		throw new MarketError(
			'github-oidc-publisher-denied',
			'This GitHub Actions job is not authorized to notify this package',
			403,
		)
	}
	return { workflowRef: publisher.workflowRef, runId, runAttempt }
}
