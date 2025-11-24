import * as v from 'valibot'
import { booleanMeta } from '~/core/actions/boolean'
import { formMeta } from '~/core/actions/formMeta'
import { numberMeta } from '~/core/actions/number'
import { stringMeta } from '~/core/actions/string'
import { unionMeta } from '~/core/actions/union'

// 示例 1: 基础开关联动 (enabled 控制其他字段显示)
const DisabledConfigSchema = v.object({
	enabled: v.pipe(
		v.literal(false),
		formMeta({ label: '启用功能', description: '开启后可以配置更多选项' }),
	),
})

const EnabledConfigSchema = v.object({
	enabled: v.pipe(
		v.literal(true),
		formMeta({ label: '启用功能', description: '开启后可以配置更多选项' }),
	),
	foo: v.pipe(
		v.number(),
		numberMeta({ variant: 'input', step: 1 }),
		formMeta({ label: '数值配置', description: '请输入一个数值' }),
	),
	bar: v.pipe(
		v.string(),
		stringMeta({ placeholder: '输入文本内容' }),
		formMeta({ label: '文本配置', description: '请输入一个字符串' }),
	),
})

export const ConditionalBasicSchema = v.optional(
	v.pipe(
		v.variant('enabled', [DisabledConfigSchema, EnabledConfigSchema]),
		formMeta({ label: '条件表单示例', description: '根据开关显示不同的字段' }),
		unionMeta({ discriminator: 'enabled', variant: 'switch' }),
	),
	{
		enabled: false,
	},
)

// 示例 2: 类型选择联动 (type 字段控制配置项)
const FooTypeSchema = v.object({
	type: v.pipe(v.literal('foo'), formMeta({ label: '配置类型' })),
	value: v.pipe(
		v.number(),
		numberMeta({ variant: 'slider', min: 0, max: 1000, step: 10 }),
		formMeta({ label: '数值参数', description: 'foo 类型的专属数值配置' }),
	),
})

const BarTypeSchema = v.object({
	type: v.pipe(v.literal('bar'), formMeta({ label: '配置类型' })),
	text: v.pipe(
		v.string(),
		stringMeta({ multiline: true, minRows: 3 }),
		formMeta({ label: '文本内容', description: 'bar 类型的专属文本配置' }),
	),
})

export const ConditionalTypeSchema = v.optional(
	v.pipe(
		v.variant('type', [FooTypeSchema, BarTypeSchema]),
		formMeta({ label: '类型切换示例', description: '根据类型显示不同的配置面板' }),
		unionMeta({
			discriminator: 'type',
			branchLabels: { foo: 'Foo 类型', bar: 'Bar 类型' },
			variant: 'segmented',
		}),
	),
	{
		type: 'foo',
		value: 500,
	},
)

// 示例 3: 多级联动 (模式 -> 协议 -> 具体配置)
const HttpConfigSchema = v.object({
	protocol: v.pipe(v.literal('http'), formMeta({ label: '协议类型' })),
	host: v.pipe(v.string(), formMeta({ label: 'HTTP 主机' })),
	port: v.pipe(
		v.number(),
		numberMeta({ variant: 'input', step: 1 }),
		formMeta({ label: 'HTTP 端口' }),
	),
})

const HttpsConfigSchema = v.object({
	protocol: v.pipe(v.literal('https'), formMeta({ label: '协议类型' })),
	host: v.pipe(v.string(), formMeta({ label: 'HTTPS 主机' })),
	port: v.pipe(
		v.number(),
		numberMeta({ variant: 'input', step: 1 }),
		formMeta({ label: 'HTTPS 端口' }),
	),
	certPath: v.pipe(
		v.string(),
		stringMeta({ placeholder: '/path/to/cert.pem' }),
		formMeta({ label: '证书路径' }),
	),
})

const WsConfigSchema = v.object({
	protocol: v.pipe(v.literal('ws'), formMeta({ label: '协议类型' })),
	endpoint: v.pipe(v.string(), formMeta({ label: 'WebSocket 端点' })),
})

const WssConfigSchema = v.object({
	protocol: v.pipe(v.literal('wss'), formMeta({ label: '协议类型' })),
	endpoint: v.pipe(v.string(), formMeta({ label: 'WebSocket 端点 (安全)' })),
	certPath: v.pipe(
		v.string(),
		stringMeta({ placeholder: '/path/to/cert.pem' }),
		formMeta({ label: '证书路径' }),
	),
})

const SimpleModeSchema = v.object({
	mode: v.pipe(v.literal('simple'), formMeta({ label: '配置模式' })),
	url: v.pipe(
		v.string(),
		stringMeta({ placeholder: 'https://example.com' }),
		formMeta({ label: 'URL 地址', description: '简单模式只需填写 URL' }),
	),
})

const AdvancedModeSchema = v.pipe(
	v.variant('protocol', [HttpConfigSchema, HttpsConfigSchema, WsConfigSchema, WssConfigSchema]),
	v.transform((input) => ({ mode: 'advanced' as const, ...input })),
	unionMeta({
		discriminator: 'protocol',
		branchLabels: { http: 'HTTP', https: 'HTTPS', ws: 'WebSocket', wss: 'WebSocket (安全)' },
		variant: 'select',
	}),
)

export const ConditionalAdvancedSchema = v.optional(
	v.pipe(
		v.variant('mode', [SimpleModeSchema, AdvancedModeSchema]),
		formMeta({ label: '多级联动示例', description: '复杂的嵌套条件配置' }),
		unionMeta({
			discriminator: 'mode',
			branchLabels: { simple: '简单模式', advanced: '高级模式' },
			variant: 'segmented',
		}),
	),
	{
		mode: 'advanced',
		protocol: 'https',
		host: 'api.example.com',
		port: 443,
		certPath: '/etc/ssl/certs/example.pem',
	},
)

// 示例 4: Union 类型 (简单联合，不使用 variant)
export const SimpleUnionSchema = v.optional(
	v.pipe(
		v.union([
			v.pipe(
				v.object({
					kind: v.pipe(v.literal('text')),
					content: v.pipe(v.string(), formMeta({ label: '文本内容' })),
				}),
				formMeta({ description: '文本类型的内容' }),
			),
			v.pipe(
				v.object({
					kind: v.pipe(v.literal('number')),
					value: v.pipe(
						v.number(),
						numberMeta({ variant: 'slider', min: 0, max: 100 }),
						formMeta({ label: '数值' }),
					),
				}),
				formMeta({ description: '数值类型的内容' }),
			),
			v.pipe(
				v.object({
					kind: v.pipe(v.literal('boolean')),
					flag: v.pipe(
						v.boolean(),
						booleanMeta({ variant: 'switch' }),
						formMeta({ label: '开关状态' }),
					),
				}),
				formMeta({ description: '布尔类型的内容' }),
			),
		]),
		formMeta({ label: '简单联合类型', description: '选择不同的数据类型' }),
		unionMeta({
			discriminator: 'kind',
			branchLabels: {
				text: '文本',
				number: '数值',
				boolean: '布尔',
			},
			variant: 'segmented',
		}),
	),
	{
		kind: 'number',
		value: 75,
	},
)
