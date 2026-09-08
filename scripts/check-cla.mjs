#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArgs(process.argv.slice(2))
const command = options._[0] ?? 'check'
const root = resolve(process.cwd(), options.root ?? scriptRoot)
const signaturesFile = resolve(root, options.signatures ?? '.cla/signatures.json')
const claFile = resolve(root, options.cla ?? 'CLA.md')
const approveCommand = '/approve-cla'

if (options['print-hash']) {
	console.log(await hashFile(claFile))
	process.exit(0)
}

switch (command) {
	case 'check':
		await checkSignature()
		break
	case 'github':
	case 'approve':
		await checkGithubPullRequest()
		break
	default:
		fail(`Unknown CLA command: ${command}`)
}

async function checkSignature() {
	const claSha256 = await hashFile(claFile)
	const context = await readCheckContext()
	const user = normalizeUser(options.user ?? process.env.CLA_USER ?? context.user)
	const host = normalizeHost(
		options.host ?? options.forge ?? process.env.CLA_HOST ?? process.env.CLA_FORGE ?? context.host,
	)

	if (!user) fail('CLA check could not determine the pull request author.')
	if (!host) fail('CLA check could not determine the code hosting site.')

	const registry = await readSignatureRegistry()
	const validationErrors = validateRegistry(registry)
	if (validationErrors.length > 0) {
		fail(`Invalid CLA signature registry:\n- ${validationErrors.join('\n- ')}`)
	}

	const validSignature = registry.signatures.find(
		(signature) =>
			normalizeHost(signature.host ?? signature.forge) === host &&
			normalizeUser(signature.username) === user &&
			signature.claSha256.toLowerCase() === claSha256,
	)

	if (!validSignature) {
		fail(
			`${host}/${user} has not approved the current CLA revision. ` +
				`Reply ${approveCommand} to the CLA comment on this pull request.`,
		)
	}

	console.log(
		`CLA accepted by ${validSignature.host ?? validSignature.forge}/${validSignature.username}.`,
	)
}

// GitHub owns the contribution identity and comment evidence. The protected base
// owns both the policy bytes and reusable signature registry; no PR files are read.
async function checkGithubPullRequest() {
	const event = await readRequiredEvent()
	const number = event.pull_request?.number ?? (event.issue?.pull_request && event.issue.number)
	if (!Number.isSafeInteger(number)) fail('CLA check requires a pull request event.')
	const pullRequest = await githubJson(`repos/${repository()}/pulls/${number}`)
	if (pullRequest.state !== 'open') {
		console.log('CLA check skipped: pull request is closed.')
		return
	}
	const headSha = pullRequest.head.sha
	const status = (state, description, targetUrl) =>
		githubJson(`repos/${repository()}/statuses/${headSha}`, {
			method: 'POST',
			body: JSON.stringify({
				state,
				context: 'CLA',
				description,
				target_url: targetUrl ?? `${serverUrl()}/${repository()}/pull/${number}`,
			}),
		})

	await status('pending', 'Checking the current CLA policy and acceptance evidence.')
	try {
		// Pin the policy and registry to the same protected base commit for this run.
		const baseSha = pullRequest.base.sha
		const [policy, registryBytes] = await Promise.all([
			readProtectedFile('CLA.md', baseSha),
			readProtectedFile('.cla/signatures.json', baseSha),
		])
		const hash = createHash('sha256').update(policy).digest('hex')
		const registry = JSON.parse(registryBytes.toString('utf8'))
		const errors = validateRegistry(registry)
		if (errors.length > 0)
			throw new Error(`Invalid protected CLA signature registry: ${errors.join('; ')}`)
		const author = normalizeUser(pullRequest.user.login)
		const host = normalizeHost(serverUrl())
		const signature = registry.signatures.find(
			(entry) =>
				normalizeHost(entry.host ?? entry.forge) === host &&
				normalizeUser(entry.username) === author &&
				entry.claSha256.toLowerCase() === hash,
		)
		if (signature) {
			await status('success', 'The author has accepted the current CLA.', signature.evidenceUrl)
			console.log(`CLA accepted by ${host}/${author} (protected registry).`)
			return
		}

		const comments = await readIssueComments(number)
		const marker = `<!-- pluxel-cla:v2 sha256:${hash} -->`
		const prompt = comments.find(
			(comment) => isWorkflowComment(comment) && comment.body.includes(marker),
		)
		const approval =
			prompt &&
			comments.find(
				(comment) =>
					normalizeUser(comment.user?.login) === author &&
					normalizeCommand(comment.body) === approveCommand &&
					comment.id > prompt.id &&
					Date.parse(comment.created_at) >= Date.parse(prompt.created_at),
			)
		if (approval) {
			const receiptMarker = `<!-- pluxel-cla:acceptance sha256:${hash} comment:${approval.id} -->`
			if (
				!comments.some(
					(comment) => isWorkflowComment(comment) && comment.body.includes(receiptMarker),
				)
			) {
				const evidence = {
					host,
					username: pullRequest.user.login,
					acceptedAt: approval.updated_at ?? approval.created_at,
					claSha256: hash,
					repository: repository(),
					pullRequest: number,
					headSha,
					evidenceUrl: approval.html_url,
				}
				await createIssueComment(
					number,
					`${receiptMarker}\nCLA acceptance verified for @${author}. Acceptance evidence for this contribution follows.\n\n` +
						'```json\n' +
						JSON.stringify(evidence, null, 2) +
						'\n```',
				)
			}
			await status('success', 'The author has accepted the current CLA.', approval.html_url)
			console.log(`CLA accepted by ${host}/${author}: ${approval.html_url}`)
			return
		}

		if (!prompt) {
			await createIssueComment(
				number,
				`${marker}\nThanks for contributing to Pluxel.\n\n` +
					`@${author}, read [CLA.md](${serverUrl()}/${repository()}/blob/${baseSha}/CLA.md), then post a new comment:\n\n` +
					`\`\`\`text\n${approveCommand}\n\`\`\`\n\n` +
					`Your authenticated comment records acceptance of CLA revision \`${hash}\`. ` +
					'The workflow updates the CLA status directly; it does not write to your branch.',
			)
		}
		await status('failure', 'Awaiting the author’s /approve-cla comment after the CLA prompt.')
		console.log(
			`CLA not accepted: @${author} must post ${approveCommand} after the current CLA prompt. The CLA status is failing.`,
		)
	} catch (error) {
		await status('error', 'CLA verification failed; inspect the workflow logs and rerun.')
		throw error
	}
}

function isWorkflowComment(comment) {
	return comment.user?.type === 'Bot' && comment.user?.login === 'github-actions[bot]'
}

async function readProtectedFile(path, sha) {
	const response = await githubJson(
		`repos/${repository()}/contents/${path}?ref=${encodeURIComponent(sha)}`,
	)
	if (response.encoding !== 'base64' || typeof response.content !== 'string') {
		throw new Error(`Protected CLA input is not a file: ${path}`)
	}
	return Buffer.from(response.content, 'base64')
}

async function readIssueComments(number) {
	const comments = []
	for (let page = 1; ; page += 1) {
		const batch = await githubJson(
			`repos/${repository()}/issues/${number}/comments?per_page=100&page=${page}`,
		)
		comments.push(...batch)
		if (batch.length < 100) return comments
	}
}

async function readSignatureRegistry() {
	try {
		return JSON.parse(await readFile(signaturesFile, 'utf8'))
	} catch (error) {
		if (error?.code === 'ENOENT') {
			fail(`CLA signature registry is missing: ${signaturesFile}`)
		}
		throw error
	}
}

function validateRegistry(registry) {
	const errors = []
	if (registry?.version !== 1) errors.push('version must be 1')
	if (!Array.isArray(registry?.signatures)) {
		errors.push('signatures must be an array')
		return errors
	}

	const seen = new Set()
	for (const [index, signature] of registry.signatures.entries()) {
		const label = `signatures[${index}]`
		const entryHost = normalizeHost(signature?.host ?? signature?.forge)
		const entryUser = normalizeUser(signature?.username)
		const entryHash = signature?.claSha256
		const entryDate = signature?.acceptedAt
		const entryRepository = signature?.repository
		const entryPullRequest = signature?.pullRequest
		const entryHeadSha = signature?.headSha
		const entryEvidenceUrl = signature?.evidenceUrl

		if (!entryHost) errors.push(`${label}.host must be a code hosting site hostname`)
		if (!entryUser) errors.push(`${label}.username must be a code hosting account username`)
		if (
			typeof entryDate !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entryDate)
		) {
			errors.push(`${label}.acceptedAt must be an ISO 8601 UTC timestamp`)
		}
		if (typeof entryHash !== 'string' || !/^[a-f0-9]{64}$/i.test(entryHash)) {
			errors.push(`${label}.claSha256 must be a SHA-256 hex digest`)
		}
		if (typeof entryRepository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(entryRepository)) {
			errors.push(`${label}.repository must be an owner/name repository`)
		}
		if (!Number.isSafeInteger(entryPullRequest) || entryPullRequest < 1) {
			errors.push(`${label}.pullRequest must be a positive integer`)
		}
		if (
			typeof entryHeadSha !== 'string' ||
			!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(entryHeadSha)
		) {
			errors.push(`${label}.headSha must be a Git object ID`)
		}
		if (typeof entryEvidenceUrl !== 'string' || !/^https:\/\/\S+$/.test(entryEvidenceUrl)) {
			errors.push(`${label}.evidenceUrl must be an HTTPS URL`)
		}

		const key = `${entryHost}/${entryUser}/${String(entryHash).toLowerCase()}`
		if (seen.has(key)) errors.push(`${label} duplicates another signature entry`)
		seen.add(key)
	}

	return errors
}

async function readCheckContext() {
	const event = await readOptionalEvent()
	const eventUser =
		event?.pull_request?.user?.login ??
		event?.pull_request?.user?.username ??
		event?.pull_request?.author?.login ??
		event?.pull_request?.author?.username ??
		event?.sender?.login ??
		event?.sender?.username
	const eventHost =
		process.env.GITHUB_SERVER_URL ?? process.env.CI_FORGE_URL ?? process.env.CI_REPO_URL

	return {
		user: eventUser ?? process.env.GITHUB_ACTOR ?? process.env.CI_COMMIT_AUTHOR,
		host: eventHost,
		issueNumber: event?.pull_request?.number,
	}
}

async function readRequiredEvent() {
	const event = await readOptionalEvent()
	if (!event) fail('GITHUB_EVENT_PATH is required for CLA approval.')
	return event
}

async function readOptionalEvent() {
	const eventPath = process.env.GITHUB_EVENT_PATH ?? process.env.FORGEJO_EVENT_PATH
	if (!eventPath) return undefined
	try {
		return JSON.parse(await readFile(eventPath, 'utf8'))
	} catch {
		return undefined
	}
}

async function createIssueComment(issueNumber, body) {
	return githubJson(`repos/${repository()}/issues/${issueNumber}/comments`, {
		method: 'POST',
		body: JSON.stringify({ body }),
	})
}

async function githubJson(path, init = {}) {
	const token = process.env.GITHUB_TOKEN
	if (!token) fail('GITHUB_TOKEN is required.')

	const response = await fetch(`${apiUrl()}/${path}`, {
		...init,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'x-github-api-version': '2022-11-28',
			...init.headers,
		},
	})

	if (!response.ok) {
		const error = new Error(
			`GitHub API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`,
		)
		error.status = response.status
		throw error
	}

	return response.json()
}

function repository() {
	const value = process.env.GITHUB_REPOSITORY
	if (!value) fail('GITHUB_REPOSITORY is required.')
	return value
}

function apiUrl() {
	return process.env.GITHUB_API_URL ?? 'https://api.github.com'
}

function serverUrl() {
	return process.env.GITHUB_SERVER_URL ?? 'https://github.com'
}

function normalizeHost(value) {
	const text = String(value ?? '')
		.trim()
		.toLowerCase()
	if (!text) return undefined
	try {
		return new URL(text).hostname.toLowerCase()
	} catch {
		return text.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
	}
}

function normalizeUser(value) {
	const text = String(value ?? '')
		.trim()
		.toLowerCase()
	return text || undefined
}

function normalizeCommand(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
}

async function hashFile(file) {
	return createHash('sha256')
		.update(await readFile(file))
		.digest('hex')
}

function parseArgs(args) {
	const parsed = { _: [] }
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]
		if (!argument.startsWith('--')) {
			parsed._.push(argument)
			continue
		}
		const [rawKey, rawValue] = argument.slice(2).split('=', 2)
		if (rawValue !== undefined) {
			parsed[rawKey] = rawValue
			continue
		}
		const next = args[index + 1]
		if (next !== undefined && !next.startsWith('--')) {
			parsed[rawKey] = next
			index += 1
		} else {
			parsed[rawKey] = true
		}
	}
	return parsed
}

function fail(message) {
	console.error(message)
	process.exit(1)
}
