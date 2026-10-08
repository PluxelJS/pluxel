import { dependencyPolicy } from './dependency-policy.mjs'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cliSourceFingerprint } from '../bin/build-state.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const output = resolve(root, 'packages/cli/dist/resources')
mkdirSync(output, { recursive: true })
const pncatNotices = resolve(output, 'third-party/pncat')
mkdirSync(pncatNotices, { recursive: true })
for (const name of ['LICENSE.md', 'UPSTREAM.md']) {
	cpSync(resolve(root, 'vendor/pncat', name), resolve(pncatNotices, name))
}
writeFileSync(
	resolve(output, 'dependency-policy.json'),
	JSON.stringify(
		dependencyPolicy(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')),
		null,
		2,
	) + '\n',
)
cpSync(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true })
cpSync(resolve(root, '.agents/skills/pluxel-development'), resolve(output, 'skill'), {
	recursive: true,
})
writeFileSync(
	resolve(root, 'packages/cli/dist/source-fingerprint'),
	cliSourceFingerprint(resolve(root, 'packages/cli')),
)
