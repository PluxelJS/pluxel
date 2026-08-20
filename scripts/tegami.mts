import { fumapressPlugin } from '@fumapress/tegami/tegami'
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { tegami, type TegamiPlugin } from 'tegami'
import { runCli } from 'tegami/cli'
import { github } from 'tegami/plugins/github'
import { repositoryPackages, tegamiIgnoredPackageNames } from './repository-packages.mjs'

const ignoredPackages = [
	...tegamiIgnoredPackageNames(repositoryPackages),
	/^@gqlens\//,
	/^@worksplit\//,
]
const execFileAsync = promisify(execFile)

export const paper = tegami({
	ignore: ignoredPackages,
	groups: {
		cli: {
			syncBump: true,
			syncGitTag: true,
		},
	},
	packages: {
		'@pluxel/cli': { group: 'cli' },
		'@pluxel/create': { group: 'cli' },
	},
	npm: {
		client: 'pnpm',
		updateLockFile: true,
		onBreakPeerDep: 'error',
		bumpDep: ({ dependent, kind, spec }) => {
			if (dependent.manifest.private === true) return false
			if (spec.protocol !== 'workspace') return false
			return kind === 'dependencies' || kind === 'optionalDependencies' ? 'patch' : false
		},
		trustedPublish: {
			provider: 'github',
			workflow: 'release.yml',
		},
	},
	plugins: [
		verifyBeforePublish(),
		fumapressPlugin({ dir: 'projects/docs/content/changelog' }),
		github({
			repo: 'PluxelJS/pluxel',
			versionPr: {
				base: 'main',
			},
		}),
	],
})

if (import.meta.main) await runCli(paper)

function verifyBeforePublish(): TegamiPlugin {
	return {
		name: 'pluxel-release-verification',
		enforce: 'pre',
		async applyCliDraft() {
			await formatChangedPackageManifests(this.cwd)
		},
		async beforePublishAll() {
			await run('pnpm', ['--filter', '@pluxel/cli', 'test:templates'], this.cwd)
		},
		async willPublish({ pkg }) {
			await run('pnpm', ['exec', 'turbo', 'run', 'build', `--filter=${pkg.name}`], this.cwd)
		},
	}
}

async function formatChangedPackageManifests(cwd: string): Promise<void> {
	const { stdout } = await execFileAsync(
		'git',
		['diff', '--name-only', '--diff-filter=ACM', '-z'],
		{ cwd, encoding: 'utf8' },
	)
	const manifests = stdout
		.split('\0')
		.filter((file) => file === 'package.json' || file.endsWith('/package.json'))
	await Promise.all(
		manifests.map(async (file) => {
			const path = resolve(cwd, file)
			const manifest = JSON.parse(await readFile(path, 'utf8'))
			await writeFile(path, `${JSON.stringify(manifest, null, '\t')}\n`)
		}),
	)
}

function run(command: string, args: string[], cwd: string): Promise<void> {
	return new Promise((complete, reject) => {
		const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) complete()
			else
				reject(
					new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`),
				)
		})
	})
}
