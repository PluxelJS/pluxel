import { BasePlugin, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'

const font = v.pipe(
	v.array(v.string()),
	f.arrayMeta({
		valueMode: 'defaults-picker',
		pickerMode: 'picker',
		picklist: {
			searchable: true,
			clearable: true,
			labels: {
				SourceHans: '思源黑体',
				Inter: 'Inter字体',
				'Maple Mono NF CN': '等宽字体',
			},
		},
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
@Plugin({ name: 'PluginAsyncSchema', type: 'hook' })
export class PluginAsyncSchema extends BasePlugin {
	private test1 = this.configs.use(fontsSelectorSchema)
	override init(): void {
		void this.test1
	}
}
