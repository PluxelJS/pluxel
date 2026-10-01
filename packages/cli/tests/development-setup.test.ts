import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
	developmentSource,
	setupDevelopmentWorkspace,
	diagnoseDevelopmentWorkspace,
} from '../src/workspace/setup'
const roots: string[] = []
function fixture() {
	const root = mkdtempSync(resolve(tmpdir(), 'pluxel-setup-'))
	roots.push(root)
	writeFileSync(resolve(root, 'package.json'), '{}')
	return root
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('links one upstream source, preserves project instructions and is repeatable', () => {
	const root = fixture()
	writeFileSync(resolve(root, 'AGENTS.md'), '# Business rules\nKeep data.\n')
	setupDevelopmentWorkspace(root)
	const agents = readFileSync(resolve(root, 'AGENTS.md'), 'utf8')
	setupDevelopmentWorkspace(root)
	expect(readFileSync(resolve(root, 'AGENTS.md'), 'utf8')).toBe(agents)
	expect(agents).toContain('Keep data.')
	expect(realpathSync(resolve(root, 'docs/pluxel'))).toBe(resolve(developmentSource().root, 'docs'))
	expect(diagnoseDevelopmentWorkspace(root)).toEqual([])
	rmSync(resolve(root, '.agents/skills/pluxel-development'))
	expect(diagnoseDevelopmentWorkspace(root).join()).toContain('resource mismatch')
})
it('refuses unowned files and links without creating setup state', () => {
	const root = fixture()
	mkdirSync(resolve(root, 'docs'))
	writeFileSync(resolve(root, 'docs/pluxel'), 'mine')
	expect(() => setupDevelopmentWorkspace(root)).toThrow(/unmanaged/)
	expect(readFileSync(resolve(root, 'docs/pluxel'), 'utf8')).toBe('mine')
	rmSync(resolve(root, 'docs/pluxel'))
	symlinkSync(resolve(developmentSource().root, 'docs'), resolve(root, 'docs/pluxel'))
	expect(() => setupDevelopmentWorkspace(root)).toThrow(/unmanaged/)
})
it('rejects a different Git checkout', () => {
	const root = fixture()
	setupDevelopmentWorkspace(root)
	expect(
		diagnoseDevelopmentWorkspace(root, { ...developmentSource(), root: fixture() }).join(),
	).toContain('source mismatch')
})
it('uses packaged resources without a Git checkout', () => {
	const root = fixture(),
		pkg = fixture()
	mkdirSync(resolve(pkg, 'dist/resources/docs/development'), { recursive: true })
	writeFileSync(resolve(pkg, 'dist/resources/docs/development/index.md'), 'docs')
	mkdirSync(resolve(pkg, 'dist/resources/skill'), { recursive: true })
	writeFileSync(resolve(pkg, 'dist/resources/skill/SKILL.md'), 'skill')
	const source = { kind: 'release' as const, root: pkg, version: '1.0.0' }
	setupDevelopmentWorkspace(root, source)
	expect(diagnoseDevelopmentWorkspace(root, source)).toEqual([])
})
