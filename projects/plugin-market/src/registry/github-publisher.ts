import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { MarketError, object, packageName, type GitHubNotificationPublisher } from '../protocol'

export type GitHubPublisher = {
	name: string
	repositoryId: string
	repositoryOwnerId: string
	workflowRef: string
	jobWorkflowRef?: string
}

export function githubPublishers(value: unknown): GitHubPublisher[] {
	if (!Array.isArray(value) || value.length > 5000)
		throw new Error('githubPublishers must be an array of at most 5000 package rules')
	const workflowRef =
		/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@refs\/(heads|tags)\/[^\s@*]+$/
	const jobWorkflowRef = /^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@[a-f0-9]{40}$/
	const id = /^[1-9]\d{0,19}$/
	return value.map((entry: unknown) => {
		if (
			!object(entry) ||
			!packageName(entry.name) ||
			typeof entry.repositoryId !== 'string' ||
			!id.test(entry.repositoryId) ||
			typeof entry.repositoryOwnerId !== 'string' ||
			!id.test(entry.repositoryOwnerId) ||
			typeof entry.workflowRef !== 'string' ||
			!workflowRef.test(entry.workflowRef) ||
			(entry.jobWorkflowRef !== undefined &&
				(typeof entry.jobWorkflowRef !== 'string' || !jobWorkflowRef.test(entry.jobWorkflowRef))) ||
			Object.keys(entry).some(
				(key) =>
					!['name', 'repositoryId', 'repositoryOwnerId', 'workflowRef', 'jobWorkflowRef'].includes(
						key,
					),
			)
		)
			throw new Error(
				'Each githubPublishers rule needs a package name, numeric repository and owner IDs, an exact caller workflow ref, and an optional SHA-pinned reusable workflow ref',
			)
		return {
			name: entry.name,
			repositoryId: entry.repositoryId,
			repositoryOwnerId: entry.repositoryOwnerId,
			workflowRef: entry.workflowRef,
			jobWorkflowRef: entry.jobWorkflowRef,
		}
	})
}

const issuer = 'https://token.actions.githubusercontent.com'
const keys = createRemoteJWKSet(new URL('/.well-known/jwks', issuer), { timeoutDuration: 5000 })

const denied = () =>
	new MarketError(
		'github-oidc-invalid',
		'A valid GitHub Actions OIDC bearer token for this operation is required',
		401,
	)

export async function authorizeGitHubPublisher(
	request: Request,
	publishers: readonly GitHubPublisher[],
	audience: string,
): Promise<GitHubNotificationPublisher> {
	const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(
		request.headers.get('Authorization') ?? '',
	)?.[1]
	if (!token || token.length > 8192) throw denied()
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
			'This GitHub Actions job is not authorized for this package',
			403,
		)
	}
	return { workflowRef: publisher.workflowRef, runId, runAttempt }
}
