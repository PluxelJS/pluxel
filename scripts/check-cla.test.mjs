import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it, onTestFinished } from 'vitest'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('./check-cla.mjs', import.meta.url))
const bot = { login: 'github-actions[bot]', type: 'Bot' }
const author = { login: 'contributor', type: 'User' }
const oldHead = 'a'.repeat(40)
const head = 'b'.repeat(40)
const base = 'c'.repeat(40)
const policyHash = (text) => createHash('sha256').update(text).digest('hex')

function comment(id, body, user = author) {
	return {
		id,
		body,
		user,
		created_at: new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(),
		html_url: `https://github.com/example/project/pull/42#issuecomment-${id}`,
	}
}

async function githubFixture() {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-cla-'))
	const model = {
		policy: 'Protected fixture agreement',
		registry: { version: 1, signatures: [] },
		pullRequest: {
			number: 42,
			state: 'open',
			user: author,
			head: { sha: head, ref: 'patch', repo: { full_name: 'contributor/fork' } },
			base: { sha: base },
		},
		comments: [],
		statuses: [],
		requests: [],
		failPolicy: false,
	}
	const server = createServer(async (request, response) => {
		let rawBody = ''
		for await (const chunk of request) rawBody += chunk
		const body = rawBody ? JSON.parse(rawBody) : undefined
		const url = new URL(request.url, 'http://localhost')
		model.requests.push({ method: request.method, path: url.pathname, query: url.search, body })
		response.setHeader('content-type', 'application/json')
		let value
		if (request.method === 'GET' && url.pathname === '/repos/example/project/pulls/42') {
			value = model.pullRequest
		} else if (
			request.method === 'GET' &&
			url.pathname.startsWith('/repos/example/project/contents/')
		) {
			if (model.failPolicy || url.searchParams.get('ref') !== base) {
				response.statusCode = 500
				value = { message: 'Protected policy unavailable' }
			} else {
				const content = url.pathname.endsWith('/CLA.md')
					? model.policy
					: JSON.stringify(model.registry)
				value = { encoding: 'base64', content: Buffer.from(content).toString('base64') }
			}
		} else if (url.pathname === '/repos/example/project/issues/42/comments') {
			if (request.method === 'GET') {
				const start = (Number(url.searchParams.get('page')) - 1) * 100
				value = model.comments.slice(start, start + 100)
			} else if (request.method === 'POST') {
				value = comment((model.comments.at(-1)?.id ?? 0) + 1, body.body, bot)
				model.comments.push(value)
			}
		} else if (
			request.method === 'POST' &&
			url.pathname.startsWith('/repos/example/project/statuses/')
		) {
			model.statuses.push({ sha: url.pathname.split('/').at(-1), ...body })
			value = body
		}
		if (!value) {
			response.statusCode = 500
			value = { message: `Unexpected request: ${request.method} ${request.url}` }
		}
		response.end(JSON.stringify(value))
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	onTestFinished(async () => {
		await new Promise((resolve) => server.close(resolve))
		await rm(directory, { recursive: true, force: true })
	})
	return {
		model,
		async run(event = { pull_request: { number: 42, head: { sha: oldHead } } }) {
			const eventPath = join(directory, 'event.json')
			await writeFile(eventPath, JSON.stringify(event))
			return exec(process.execPath, [script, 'github'], {
				env: {
					...process.env,
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_TOKEN: 'test-token',
					GITHUB_REPOSITORY: 'example/project',
					GITHUB_SERVER_URL: 'https://github.com',
					GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
				},
			})
		},
	}
}

it('completes fork approval on the existing head status without executing or writing PR contents', async () => {
	const { model, run } = await githubFixture()
	const initial = await run()
	assert.match(initial.stdout, /CLA status is failing/)
	assert.equal(model.statuses.at(-1).state, 'failure')
	const prompt = model.comments[0]
	assert.ok(prompt.body.includes(`/blob/${base}/CLA.md`))
	const approval = comment(prompt.id + 1, '/approve-cla')
	model.comments.push(approval)
	await run({ issue: { number: 42, pull_request: {} }, comment: approval })
	assert.equal(model.statuses.at(-1).state, 'success')
	assert.equal(model.statuses.at(-1).target_url, approval.html_url)
	assert.ok(model.statuses.every((status) => status.sha === head && status.context === 'CLA'))
	assert.ok(model.requests.every((request) => !request.path.includes('contributor/fork')))
	assert.ok(model.requests.every((request) => request.method !== 'PUT'))
	assert.ok(
		model.requests
			.filter((request) => request.path.includes('/contents/'))
			.every((request) => request.query === `?ref=${base}`),
	)
	const count = model.comments.length
	await run()
	assert.equal(model.comments.length, count, 'rerunning should not duplicate prompts or receipts')
})

it('ignores forged prompts and another account’s approval', async () => {
	const { model, run } = await githubFixture()
	const hash = policyHash(model.policy)
	model.comments.push(
		comment(1, `<!-- pluxel-cla:v2 sha256:${hash} -->`),
		comment(2, '/approve-cla'),
	)
	await run()
	assert.equal(model.statuses.at(-1).state, 'failure')
	assert.equal(model.comments.at(-1).user, bot)
	model.comments.push(comment(4, '/approve-cla', { login: 'other', type: 'User' }))
	await run()
	assert.equal(model.statuses.at(-1).state, 'failure')
})

it('finds authenticated acceptance beyond the first page and stops accepting removed evidence', async () => {
	const { model, run } = await githubFixture()
	await run()
	for (let id = 2; id <= 105; id += 1) model.comments.push(comment(id, 'Discussion'))
	model.comments.push(comment(106, '/approve-cla'))
	await run()
	assert.equal(model.statuses.at(-1).state, 'success')
	assert.ok(model.requests.some((request) => request.query.includes('page=2')))
	model.comments = model.comments.filter((entry) => entry.id !== 106)
	await run({ action: 'deleted', issue: { number: 42, pull_request: {} } })
	assert.equal(
		model.statuses.at(-1).state,
		'failure',
		'a receipt cannot substitute for the author’s actual comment',
	)
})

it('requires new acceptance when protected policy changes and binds status to the current head', async () => {
	const { model, run } = await githubFixture()
	await run()
	model.comments.push(comment(2, '/approve-cla'))
	await run()
	model.policy += '\nRevised fixture policy'
	model.pullRequest.head.sha = 'd'.repeat(40)
	await run()
	assert.equal(model.statuses.at(-1).state, 'failure')
	assert.equal(model.statuses.at(-1).sha, 'd'.repeat(40))
	model.comments.push(comment(model.comments.at(-1).id + 1, '/approve-cla'))
	await run()
	assert.equal(model.statuses.at(-1).state, 'success')
})

it('preserves protected registry acceptance and fails closed on policy API errors', async () => {
	const { model, run } = await githubFixture()
	model.registry.signatures.push({
		host: 'github.com',
		username: author.login,
		claSha256: policyHash(model.policy),
		acceptedAt: '2026-01-01T00:00:00.000Z',
		repository: 'example/project',
		pullRequest: 1,
		headSha: oldHead,
		evidenceUrl: 'https://github.com/example/project/pull/1#issuecomment-1',
	})
	await run()
	assert.equal(model.statuses.at(-1).state, 'success')
	assert.equal(model.comments.length, 0)
	model.failPolicy = true
	await assert.rejects(run(), /Protected policy unavailable/)
	assert.equal(model.statuses.at(-1).state, 'error')
})
