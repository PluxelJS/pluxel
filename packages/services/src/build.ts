import { pluxel, type PluxelApplicationBuildOptions } from '@pluxel/rolldown'

/** Build official services artifacts; output delivery defaults to standalone, variant to workbench. */
export function buildPreset(
	options: PluxelApplicationBuildOptions = {},
): ReturnType<typeof pluxel> {
	return pluxel({ ...options, variant: options.variant ?? 'workbench' })
}
