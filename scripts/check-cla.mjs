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

const claSha256 = await hashFile(claFile)

if (options['print-hash']) {
	console.log(claSha256)
	process.exit(0)
}

switch (command) {
	case 'check':
		await checkSignature()
		break
	case 'approve':
		await approveFromComment()
		break
	default:
		fail(`Unknown CLA command: ${command}`)
}

async function checkSignature() {
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
		await requestApproval(context, { host, user })
		fail(
			`${host}/${user} has not approved the current CLA revision. ` +
				`Reply ${approveCommand} to the CLA comment on this pull request.`,
		)
	}

	console.log(
		`CLA accepted by ${validSignature.host ?? validSignature.forge}/${validSignature.username}.`,
	)
}

async function approveFromComment() {
	const event = await readRequiredEvent()
	if (!event.issue?.pull_request) {
		console.log('CLA approval skipped: comment is not on a pull request.')
		return
	}
	if (normalizeCommand(event.comment?.body) !== approveCommand) {
		console.log(`CLA approval skipped: comment is not ${approveCommand}.`)
		return
	}

	const pullRequest = await githubJson(`repos/${repository()}/pulls/${event.issue.number}`)
	const commenter = normalizeUser(event.comment?.user?.login)
	const author = normalizeUser(pullRequest.user?.login)
	if (!commenter || commenter !== author) {
		await createIssueComment(
			event.issue.number,
			`Only the pull request author can approve the CLA for this contribution.`,
		)
		fail('CLA approval rejected: comment author is not the pull request author.')
	}

	const host = normalizeHost(serverUrl())
	const entry = {
		host,
		username: pullRequest.user.login,
		acceptedAt: new Date().toISOString(),
		claSha256,
		repository: repository(),
		pullRequest: event.issue.number,
		headSha: pullRequest.head.sha,
		evidenceUrl: event.comment.html_url,
	}
	const update = await updateSignatureFile(pullRequest, entry)

	await createIssueComment(
		event.issue.number,
		update.changed
			? `Recorded CLA approval for @${pullRequest.user.login} in \`.cla/signatures.json\`.`
			: `CLA approval for @${pullRequest.user.login} is already recorded in \`.cla/signatures.json\`.`,
	)
	console.log(`CLA approval recorded for ${entry.host}/${entry.username}.`)
}

async function updateSignatureFile(pullRequest, entry) {
	const path = '.cla/signatures.json'
	const ownerRepo = pullRequest.head.repo.full_name
	const branch = pullRequest.head.ref
	const current = await readRemoteSignatureFile(ownerRepo, path, branch)
	const registry = current?.registry ?? { version: 1, signatures: [] }
	const validationErrors = validateRegistry(registry)
	if (validationErrors.length > 0) {
		fail(
			`Invalid CLA signature registry on pull request branch:\n- ${validationErrors.join('\n- ')}`,
		)
	}

	const exists = registry.signatures.some(
		(signature) =>
			normalizeHost(signature.host ?? signature.forge) === entry.host &&
			normalizeUser(signature.username) === normalizeUser(entry.username) &&
			signature.claSha256.toLowerCase() === entry.claSha256,
	)
	if (exists) return { changed: false }

	registry.signatures.push(entry)
	registry.signatures.sort((left, right) =>
		[
			normalizeHost(left.host ?? left.forge),
			normalizeUser(left.username),
			left.acceptedAt,
			left.claSha256,
		]
			.join('\0')
			.localeCompare(
				[
					normalizeHost(right.host ?? right.forge),
					normalizeUser(right.username),
					right.acceptedAt,
					right.claSha256,
				].join('\0'),
			),
	)

	try {
		await githubJson(`repos/${ownerRepo}/contents/${path}`, {
			method: 'PUT',
			body: JSON.stringify({
				branch,
				message: `chore: record CLA approval for ${entry.username}`,
				content: Buffer.from(`${JSON.stringify(registry, null, '\t')}\n`).toString('base64'),
				...(current?.sha ? { sha: current.sha } : {}),
			}),
		})
	} catch (error) {
		await createIssueComment(
			pullRequest.number,
			`I could not update \`.cla/signatures.json\` automatically. A maintainer may need to record the CLA approval for @${entry.username}.`,
		)
		throw error
	}

	return { changed: true }
}

async function readRemoteSignatureFile(ownerRepo, path, branch) {
	try {
		const response = await githubJson(
			`repos/${ownerRepo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
		)
		return {
			sha: response.sha,
			registry: JSON.parse(Buffer.from(response.content, 'base64').toString('utf8')),
		}
	} catch (error) {
		if (error.status === 404) return undefined
		throw error
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

async function requestApproval(context, identity) {
	if (!context.issueNumber || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return

	const marker = `<!-- pluxel-cla:v1 sha256:${claSha256} -->`
	const comments = await githubJson(
		`repos/${repository()}/issues/${context.issueNumber}/comments?per_page=100`,
	)
	if (comments.some((comment) => comment.body.includes(marker))) return

	await createIssueComment(
		context.issueNumber,
		`${marker}
Thanks for contributing to Pluxel.

Before this pull request can be merged, @${identity.user} must read [CLA.md](./CLA.md) and comment:

\`\`\`text
${approveCommand}
\`\`\`

That comment will record this approval in \`.cla/signatures.json\` on the pull request branch.

Current CLA revision: \`${claSha256}\``,
	)
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
