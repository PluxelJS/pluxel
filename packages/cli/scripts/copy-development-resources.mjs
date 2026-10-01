import { cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const output = resolve(root, 'packages/cli/dist/resources')
mkdirSync(output, { recursive: true })
cpSync(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true })
cpSync(resolve(root, '.agents/skills/pluxel-development'), resolve(output, 'skill'), {
	recursive: true,
})
