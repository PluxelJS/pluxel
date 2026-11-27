import { define } from 'gunshi'
import { relative, resolve } from 'node:path'
import { loadOfficialCapability } from '../capability-loader'
import { i18nCommandDefinition } from '../command-manifest'

export const i18nCommand = define({
	...i18nCommandDefinition,
	async run(ctx) {
		const root = resolve(ctx.values.root ?? '.')
		const { compilePluxelParaglide } = await loadOfficialCapability('rolldown-i18n', { cwd: root })
		const project = await compilePluxelParaglide(root)
		if (!project) throw new Error(`[i18n] Missing project.inlang/settings.json in ${root}`)
		ctx.log(`[i18n] Generated messages and declarations in ${relative(root, project.outdir)}`)
	},
})
