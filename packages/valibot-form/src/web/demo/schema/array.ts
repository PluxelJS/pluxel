import * as v from 'valibot'
import * as f from '~/index'

/** 单个 Bot 配置 - 用于演示 array 嵌套 object */
const SingleBotConfig = v.object({
	name: v.pipe(
		v.optional(v.string(), ''),
		f.formMeta({ label: '名称' }),
		f.stringMeta({ placeholder: '机器人名称' }),
	),
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用' }),
		f.booleanMeta({ variant: 'switch' }),
	),
	token: v.pipe(
		v.string(),
		v.minLength(1),
		f.formMeta({ label: 'Token', description: 'Bot Token', layout: { fullWidth: true } }),
		f.stringMeta({ mode: 'password', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }),
	),
})

/** 嵌套数组 Schema - 演示 array<object> 递归渲染 */
export const NestedArraySchema = v.object({
	cmdPrefix: v.pipe(
		v.optional(v.string(), '/'),
		v.minLength(1),
		v.maxLength(1),
		f.formMeta({ label: '指令前缀', description: '用于识别指令的前缀字符' }),
		f.stringMeta({ placeholder: '/' }),
	),
	bots: v.pipe(
		v.optional(v.array(SingleBotConfig), []),
		f.formMeta({ label: '机器人列表', description: '配置多个机器人' }),
		f.arrayMeta({
			layout: 'list',
			addLabel: '添加机器人',
			itemLabel: '机器人',
			emptyHint: '还没有配置任何机器人',
		}),
	),
})

// ========== 复杂嵌套演示：array<union> + 多层嵌套 ==========

/** HTTP 连接配置 */
const HttpConnectionSchema = v.object({
	type: v.pipe(v.literal('http'), f.formMeta({ label: '连接类型', hidden: true })),
	url: v.pipe(
		v.string(),
		f.formMeta({ label: 'URL', layout: { fullWidth: true } }),
		f.stringMeta({ placeholder: 'https://api.example.com' }),
	),
	timeout: v.pipe(
		v.optional(v.number(), 30000),
		f.formMeta({ label: '超时(ms)', layout: { fullWidth: true } }),
		f.numberMeta({ variant: 'input', step: 1000 }),
	),
})

/** WebSocket 连接配置 */
const WsConnectionSchema = v.object({
	type: v.pipe(v.literal('ws'), f.formMeta({ label: '连接类型', hidden: true })),
	endpoint: v.pipe(
		v.string(),
		f.formMeta({ label: '端点' }),
		f.stringMeta({ placeholder: 'wss://ws.example.com' }),
	),
	reconnect: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '自动重连' }),
		f.booleanMeta({ variant: 'switch' }),
	),
})

/** 连接配置（Union） */
const ConnectionConfigSchema = v.pipe(
	v.variant('type', [HttpConnectionSchema, WsConnectionSchema]),
	f.unionMeta({
		discriminator: 'type',
		branchLabels: { http: 'HTTP', ws: 'WebSocket' },
		variant: 'segmented',
	}),
)

/** 服务配置 - 演示 object 内嵌 array<union> */
const ServiceConfigSchema = v.object({
	name: v.pipe(
		v.string(),
		f.formMeta({ label: '服务名' }),
		f.stringMeta({ placeholder: '服务名称' }),
	),
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用' }),
		f.booleanMeta({ variant: 'switch' }),
	),
	connections: v.pipe(
		v.optional(v.array(ConnectionConfigSchema), []),
		f.formMeta({ label: '连接列表', description: '可配置多个连接', layout: { fullWidth: true } }),
		f.arrayMeta({
			layout: 'list',
			addLabel: '添加连接',
			itemLabel: '连接',
			emptyHint: '暂无连接配置',
			defaultItem: { type: 'http', url: '', timeout: 30000 },
		}),
	),
})

/** 复杂嵌套 Schema - 演示多层嵌套 + union 联动 */
export const ComplexNestedSchema = v.object({
	projectName: v.pipe(
		v.optional(v.string(), ''),
		f.formMeta({ label: '项目名称' }),
		f.stringMeta({ placeholder: 'My Project' }),
	),
	services: v.pipe(
		v.optional(v.array(ServiceConfigSchema), []),
		f.formMeta({ label: '服务列表', description: '配置多个服务，每个服务可有多个连接' }),
		f.arrayMeta({
			layout: 'list',
			addLabel: '添加服务',
			itemLabel: '服务',
			emptyHint: '还没有配置任何服务',
			defaultItem: { name: '', enabled: true, connections: [] },
		}),
	),
})

export const ArrayShowcaseSchema = v.object({
	tags: v.pipe(
		v.array(v.string()),
		f.arrayMeta({
			layout: 'list',
			addLabel: '添加标签',
			itemLabel: '标签',
			emptyHint: '还没有任何标签',
		}),
	),
	numbers: v.pipe(
		v.array(v.number()),
		f.arrayMeta({
			layout: 'grid',
			columns: 3,
			itemLabel: '数值',
			// 可选扩展：空数组新增时给默认值
			defaultItem: 100,
			maxItems: 6,
		}),
	),
	flags: v.pipe(
		v.array(v.boolean()),
		f.arrayMeta({
			layout: 'table',
			itemLabel: '开关',
			minItems: 1,
		}),
	),
	mixed: v.pipe(
		v.array(v.unknown()),
		f.arrayMeta({
			layout: 'list',
			itemLabel: '任意值',
			valueMode: 'auto',
		}),
	),
	multiPick: v.pipe(
		v.array(v.picklist(['alpha', 'beta', 'gamma', 'delta'] as const)),
		f.arrayMeta({
			valueMode: 'picklist',
			pickerMode: 'picker',
			picklist: {
				searchable: false,
				clearable: true,
				options: ['alpha', 'beta', 'gamma', 'delta'],
				labels: {
					alpha: '选项 A',
					beta: '选项 B',
					gamma: '选项 C',
					delta: '选项 D',
				},
			},
			emptyHint: '通过一个控件即可多选',
		}),
	),
	// 新增：defaults-picker 模式，选项来自 tanstack form 的 defaultValues
	dynamicPick: v.pipe(
		v.array(v.string()),
		f.arrayMeta({
			valueMode: 'defaults-picker',
			pickerMode: 'picker',
			picklist: {
				searchable: true,
				clearable: true,
				labels: {
					apple: '苹果',
					banana: '香蕉',
					cherry: '樱桃',
					durian: '榴莲',
				},
			},
			emptyHint: '选项来自 defaultValues',
		}),
		f.formMeta({
			label: '动态选项（defaults-picker）',
			description: '选项列表来自 tanstack form 的 defaultValues',
		}),
	),
})
