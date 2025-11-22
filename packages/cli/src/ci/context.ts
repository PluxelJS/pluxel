export type CiProvider = 'github' | 'gitlab'

export interface RepoInfo {
	host: string
	repo: string
	provider: CiProvider
}

export interface CiContext extends RepoInfo {
	runId?: string
	ref?: string
	commit?: string
}

export function detectCiContext(env: NodeJS.ProcessEnv = process.env): CiContext | undefined {
	const github = detectGithub(env)
	if (github) return github

	const gitlab = detectGitlab(env)
	if (gitlab) return gitlab

	return undefined
}

export function resolveRepoFromCi(env: NodeJS.ProcessEnv = process.env): RepoInfo | undefined {
	const context = detectCiContext(env)
	if (!context) return undefined
	return {
		host: context.host,
		repo: context.repo,
		provider: context.provider,
	}
}

export function isCi(env: NodeJS.ProcessEnv = process.env) {
	return env.CI === 'true' || Boolean(detectCiContext(env))
}

function detectGithub(env: NodeJS.ProcessEnv): CiContext | undefined {
	const active = readEnv('GITHUB_ACTIONS', env) === 'true'
	if (!active) return undefined

	const repo = readEnv('GITHUB_REPOSITORY', env)
	if (!repo) return undefined

	const host =
		readHost(env.GITHUB_SERVER_URL) ??
		(env.GITHUB_SERVER_URL ? stripProtocol(env.GITHUB_SERVER_URL) : undefined) ??
		'github.com'

	return {
		provider: 'github',
		host,
		repo: repo.replace(/^\//, ''),
		runId: readEnv('GITHUB_RUN_ID', env),
		ref: readEnv('GITHUB_REF', env),
		commit: readEnv('GITHUB_SHA', env),
	}
}

function detectGitlab(env: NodeJS.ProcessEnv): CiContext | undefined {
	const active = readEnv('GITLAB_CI', env) === 'true'
	if (!active) return undefined

	const repo =
		readEnv('CI_PROJECT_PATH', env) ??
		stripLeadingSlash(extractRepoFromUrl(env.CI_PROJECT_URL)) ??
		undefined
	if (!repo) return undefined

	const host =
		readEnv('CI_SERVER_HOST', env) ??
		readHost(env.CI_SERVER_URL) ??
		(env.CI_SERVER_URL ? stripProtocol(env.CI_SERVER_URL) : undefined) ??
		'gitlab.com'

	return {
		provider: 'gitlab',
		host,
		repo: stripLeadingSlash(repo),
		runId: readEnv('CI_PIPELINE_ID', env) ?? readEnv('CI_JOB_ID', env),
		ref: readEnv('CI_COMMIT_REF_NAME', env),
		commit: readEnv('CI_COMMIT_SHA', env),
	}
}

function readEnv(name: string, env: NodeJS.ProcessEnv) {
	const value = env[name]
	return typeof value === 'string' ? value : undefined
}

function readHost(url: string | undefined) {
	if (!url) return undefined
	try {
		return new URL(url).host
	} catch {
		return undefined
	}
}

function stripProtocol(url: string | undefined) {
	if (!url) return undefined
	return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function extractRepoFromUrl(url: string | undefined) {
	if (!url) return undefined
	try {
		const u = new URL(url)
		return u.pathname.replace(/\.git$/, '').replace(/^\//, '')
	} catch {
		return undefined
	}
}

function stripLeadingSlash(value: string | undefined) {
	if (!value) return value
	return value.replace(/^\//, '')
}
