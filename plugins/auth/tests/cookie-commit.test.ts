import { describe, expect, it } from 'vitest'
import { handleCookieCommit } from '../src/cookie-commit.ts'
import { SessionStore } from '../src/sessions.ts'

function request(ticket: string, origin: string = 'https://admin.example'): Request {
	return new Request('https://admin.example/__pluxel/admin-access/cookie/commit', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ ticket }),
	})
}

describe('narrow cookie commit HTTP boundary', () => {
	it('commits one same-origin ticket without returning management data', async () => {
		const sessions = new SessionStore()
		const commit = sessions.issueCommit({ subject: 'local:admin' }, 'password', true)
		const first = await handleCookieCommit(
			request(commit.ticket),
			{
				local: false,
				secure: true,
			},
			sessions,
		)
		expect(first.status).toBe(204)
		expect(first.headers.get('set-cookie')).toContain('__Host-pluxel_admin_session=')
		expect(await first.text()).toBe('')

		const replay = await handleCookieCommit(
			request(commit.ticket),
			{
				local: false,
				secure: true,
			},
			sessions,
		)
		expect(replay.status).toBe(401)
	})

	it('rejects cross-origin and insecure remote commits', async () => {
		const sessions = new SessionStore()
		const commit = sessions.issueCommit({ subject: 'local:admin' }, 'password', true)
		const crossOrigin = await handleCookieCommit(
			request(commit.ticket, 'https://evil.example'),
			{
				local: false,
				secure: true,
			},
			sessions,
		)
		expect(crossOrigin.status).toBe(404)
		const insecureRemote = await handleCookieCommit(
			request(commit.ticket),
			{
				local: false,
				secure: false,
			},
			sessions,
		)
		expect(insecureRemote.status).toBe(404)
	})
})
