import { expect, it } from 'vitest'
import * as publicBuild from '../src/cli/index'
import * as officialCli from '../src/internal-cli'

it('keeps process-owned runner behind the official CLI allowlist', () => {
	expect(publicBuild).not.toHaveProperty('runWithTsdown')
	expect(Object.keys(officialCli).sort()).toEqual([
		'pluginPackage',
		'resolveBuildContext',
		'runWithTsdown',
	])
})
