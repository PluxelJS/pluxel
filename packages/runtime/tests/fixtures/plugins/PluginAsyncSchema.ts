import { BasePlugin, f, Plugin, v } from '@pluxel/runtime'

const font = v.pipe(
	v.array(
		v.pipe(
			v.picklist(['SourceHans', 'Inter', 'Maple Mono NF CN'] as const),
			f.picklistMeta({
				searchable: true,
				clearable: true,
				labels: {
					SourceHans: '思源黑体',
					Inter: 'Inter字体',
					'Maple Mono NF CN': '等宽字体',
				},
			}),
		),
	),
	f.arrayMeta({
		layout: 'picker',
		emptyHint: '选项来自 defaultValues',
	}),
)
const fontsSelectorSchema = v.objectAsync({
	fonts: v.pipeAsync(
		v.optionalAsync(font, async () => ['SourceHans', 'Inter', 'Maple Mono NF CN']),

		f.formMeta({
			label: '动态选项（defaults-picker）',
			description: '选项列表来自 tanstack form 的 defaultValues',
		}),
	),
})
@Plugin({ displayName: 'Async schema' })
export class PluginAsyncSchema extends BasePlugin {
	private test1 = this.configs.use(fontsSelectorSchema)
	override init(): void {
		void this.test1
	}
}
