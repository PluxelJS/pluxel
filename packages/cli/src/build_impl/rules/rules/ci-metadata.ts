import type { PackageJson } from 'pkg-types'
import { resolveRepoFromCi } from '../../../ci/context'
import type { RuleContext } from '../types'

export async function ciMetadataRule(pkg: PackageJson, _context: RuleContext) {
	const repo = resolveRepoFromCi()
	if (!repo) return undefined
	const baseUrl = `https://${repo.host}/${repo.repo.replace(/^\//, '')}`
	const nextRepo = { type: 'git', url: `${baseUrl}.git` }
	const prevRepo = pkg.repository

	const messages: string[] = []

	if (!isRepoEqual(prevRepo, nextRepo)) {
		pkg.repository = nextRepo
		messages.push(`repository set to ${nextRepo.url}`)
	}

	if (!pkg.homepage || pkg.homepage !== baseUrl) {
		pkg.homepage = baseUrl
		messages.push(`homepage set to ${baseUrl}`)
	}

	const bugsUrl = repo.provider === 'gitlab' ? `${baseUrl}/-/issues` : `${baseUrl}/issues`
	if (!pkg.bugs || !isBugsEqual(pkg.bugs, bugsUrl)) {
		pkg.bugs = { url: bugsUrl }
		messages.push(`bugs.url set to ${bugsUrl}`)
	}

	return messages.length > 0 ? messages : undefined
}

function isRepoEqual(prev: PackageJson['repository'], next: { type: string; url: string }) {
	if (!prev) return false
	if (typeof prev === 'string') return prev === next.url
	return prev.type === next.type && prev.url === next.url
}

function isBugsEqual(prev: PackageJson['bugs'], nextUrl: string) {
	if (!prev) return false
	if (typeof prev === 'string') return prev === nextUrl
	return prev.url === nextUrl
}
