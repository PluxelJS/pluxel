import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const FontsConfig = v.object({
	defaultFamily: v.pipe(
		v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
		f.formMeta({
			title: 'Default font family',
			description:
				'Preferred system font when Workbench has no override. Omit to select an installed platform default automatically.',
		}),
	),
	maxRegistrationsPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_024)), 32),
		f.formMeta({
			title: 'Registrations per consumer',
			description: 'Maximum active programmatic font registrations owned by one caller plugin.',
		}),
	),
	maxManagedFonts: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_024)), 64),
		f.formMeta({
			title: 'Maximum managed fonts',
			description: 'Maximum fonts in the provider-owned persisted collection.',
		}),
	),
	maxFontBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 16 * MIB),
		f.formMeta({
			title: 'Maximum font bytes',
			description: 'Maximum size of one registered or uploaded font file.',
		}),
	),
})

export type FontsPluginConfig = v.InferOutput<typeof FontsConfig>
