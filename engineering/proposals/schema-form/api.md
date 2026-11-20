# 字段契约与公开 API

状态：拟议 API，尚未实现。包定位与消费者边界见 [提案概览](README.md)。

## 从三个使用任务设计入口

作者为既有 schema 添加标题、分组和控件偏好；工具从 schema 提取字段及原始输入描述；UI 消费者解析字段模型并绑定自己的值和交互。这三个任务共用元数据语义，schema 库选择体现在 import 路径。

| 入口           | 建议保留或增加的公开能力                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 根入口         | `FieldNode`、`FieldMeta`、`FormMeta` 与各类型 metadata；`parseFormFields()`；纯数据的 `planFieldSections()`                                                                                |
| `/valibot`     | `formMeta()`、`stringMeta()`、`numberMeta()`、`picklistMeta()`、`arrayMeta()`、`recordMeta()`、`objectMeta()`、`unionMeta()`；`extractField()`、`extractFormFields()`、`projectRawInput()` |
| `/json-schema` | `withFormMeta()`；同名的 `extractField()`、`extractFormFields()`、`projectRawInput()`                                                                                                      |

相同任务保留相同函数名，通过子路径选择输入体系。根入口不自动识别任意 schema 库。`createMetaFactory`、vendor 探测、renderer 默认文案和 schema walker 等 helper 保持私有，已有公开 helper 的真实消费者先按 [迁移清单](migration.md) 核查。

`parseFormFields(unknown)` 校验并返回不可变的字段树，供网络、文件或其他不可信边界使用；它验证模型结构及元数据，不验证表单值。字段提取返回相同模型，调用方无需再做一遍字段映射。Pluxel 的 RPC envelope 继续自行管理协议版本，包不加入 Plugin owner、revision 或保存状态。

## 字段模型的语义

`FieldNode` 是可序列化的判别联合。首版保留现有 `string`、`number`、`boolean`、`picklist`、`array`、`record`、`object`、`union`、`unsupported` 语义，逐项核对真实消费者后确定精确签名。

| 内容                               | 来源与约束                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| kind、必填、可空、选项、边界       | 原始输入 schema；必填与可空分别表达，`null` 与缺失有不同含义      |
| label、说明、分组、控件偏好        | 标准 annotation 与 typed metadata；schema 类型及验证规则保持权威  |
| 对象、数组、record、union 的子结构 | 结构化树边；数组项和 record 值是模板，不能伪装为某个实际值的位置  |
| 不支持的字段                       | 明确的 `unsupported` 节点、稳定原因码及 schema 位置；保留用户数据 |

共享模型只包含 JSON 数据。schema 对象、函数、ReactNode、组件 props、DOM id、表单实例和 TanStack field handle 均属于生产者或消费者内部。

具体值的位置使用 segment 数组，例如 `['servers', 0, 'port']`；schema 的诊断位置使用 JSON Pointer 或等价结构化位置，两者分别命名。对象键 `a.b`、`0`、`a/b` 不因路径编码改变含义。树的层级和路径从结构推导，现有 `depth` 与拼接字符串 `path` 的重复缓存应移除。Pluxel 的错误及表单绑定 adapter 负责与第三方字段名格式之间的可逆转换，无法无损绑定时显式报告。

展示能力不足以安全修改整个集合时，在需要原子替换的 array、record 或 union 节点标记 `unsupported`。普通 object 的单个不支持子字段可以只读保留，其余子字段仍按明确路径编辑。这个判断由提取器统一完成，避免每个 renderer 再猜一次是否会丢失数据。

字段计划表达已知约束，不承诺完整执行任意 schema。`format` 等提示是否参与数据校验由校验适配明确声明。浏览器对输入的即时反馈不能替代提交时的权威验证。

## Valibot 作者写法

以下为迁移后的目标写法；现有 `f.*Meta()` 名称和 pipe 组合保留。

```ts
import * as v from 'valibot'
import * as f from '@pluxel/schema-form/valibot'

export const Config = v.object({
	port: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(65535),
			f.formMeta({ title: '监听端口', section: 'network' }),
			f.numberMeta({ step: 1 }),
		),
		8787,
	),
})

const fields = f.extractFormFields(Config)
```

`formMeta` 中的标题、说明继续与 Valibot 标准 metadata 互操作。重复文案依照已有 pipe 顺序处理；各类型 metadata 的合并规则应明确到属性层级，不能因内部存储迁移而悄悄丢失先前 action。推荐示例为每种 metadata 一次声明。

提取器读取输入侧结构，不执行 validation、transform、lazy getter 或 default getter。`v.pipe(v.string(), v.transform(Number))` 对编辑器仍是字符串输入，服务器输出可以是数字。无法静态确定输入结构时返回 `unsupported`，不通过执行用户代码猜测字段。

## JSON Schema / TypeBox 作者写法

`withFormMeta(schema, metadata)` 同时获得 schema 和展示信息，可以为明确类型的字段提供对应参数，并保留原 schema 的类型推导。公共 metadata 定义与 Valibot 入口共用。

以下为拟议用法：

```ts
import Type from 'typebox'
import { extractFormFields, withFormMeta } from '@pluxel/schema-form/json-schema'

export const Config = Type.Object({
	port: withFormMeta(Type.Integer({ minimum: 1, maximum: 65535, default: 8787 }), {
		title: '监听端口',
		section: 'network',
		number: { step: 1 },
	}),
})

type ConfigValue = Type.Static<typeof Config>
const fields = extractFormFields(Config, { dialect: '2020-12' })
```

这个例子只定义、描述并提取字段。把它用于 Pluxel config 还需要 [运行时校验适配](pluxel.md)。

helper 的要求：

- 明确的 number/string/array 等 schema 获得对应 metadata 补全；`stepp`、错误的 `step` 类型和不适用的类型分组应被拒绝。meta 参数不能反过来把 schema 泛型推宽以绕开检查。
- 类型专属信息放在 `number`、`string`、`array` 等分组，避免字段布局与数组布局的 `layout` 重名。
- 保留 TypeBox 的静态类型、optional/readonly 等标记；不通过 JSON 往返或 `as any` 抹掉库携带的信息。普通 `as const` JSON Schema 也能使用 helper。
- 返回带注解的新 schema，不修改传入对象。标准 `title`、`description` 等只有一个最终位置；helper 中明确提供的值覆盖该位置，省略保持原值。
- helper 自己和提取器均验证扩展 metadata。TypeScript 的结构类型不能保证所有预声明变量都没有额外属性，外部 JSON 更需要运行时检查。

对于来自文件、类型已经变宽的 schema，只能依据仍然可知的信息给出补全，具体适用性由提取时检查。首版不承诺从任意 `$ref`、复杂条件或宽类型对象中恢复精确的 TypeScript 类型。

建议将输出注解统一命名为 `x-schema-form`，例如上面的字段会包含：

```json
{
	"type": "integer",
	"minimum": 1,
	"maximum": 65535,
	"default": 8787,
	"title": "监听端口",
	"x-schema-form": {
		"section": "network",
		"number": { "step": 1 }
	}
}
```

这是包拥有的展示 annotation。数据校验器显式接受并忽略它的验证作用；字段提取器校验其形状并解释展示含义。[JSON Schema 自定义注解说明](https://json-schema.org/blog/posts/custom-annotations-will-continue)提供扩展机制，具体字段属于本包。此前讨论中的 `x-pluxel-form` 尚未实现，目标只保留一个名称。

JSON Schema 的 `default` 是注解，提取器不填入值。`readOnly`、`writeOnly` 和密码控件也不会自动提供权限校验或秘密存储；Pluxel 的机密信息继续使用 Vault。[标准注解语义](https://json-schema.org/understanding-json-schema/reference/annotations)

## 支持范围与诊断

JSON Schema 入口首批以 Draft 7 和 2020-12 的常用配置结构为目标。以 `$schema` 或显式 `dialect` 选择语义；两者冲突或无法确定时给出诊断。TypeBox 未写 `$schema` 的对象在独立调用中显式选择 dialect，Pluxel 适配也固定同一选择。

| 结构                                                 | 首批目标                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| string、number/integer、boolean、nullable scalar     | 提取字段、必填/可空和已知约束                                   |
| primitive `enum`、`const`                            | 使用保留值类型的选项；`false`、`0`、`null` 不转成有歧义的字符串 |
| object/properties/required、同构 array/items、record | 对应现有嵌套编辑能力；额外属性和未知值按 schema 接纳规则保留    |
| 有唯一字面量 discriminator 的对象分支                | 提取 union；切换语义见 UI 设计                                  |
| 文档内 `$ref`、`$defs`/`definitions`                 | 解析已提供文档中的引用；不触发隐式网络请求                      |
| 外部引用                                             | 使用显式提供的 schema 文档映射；缺失引用报告位置与目标          |
| 递归、异构 tuple、复杂交叉或无唯一编辑结构的组合     | 首版显式 `unsupported`；不把 `allOf` 简单合并为 object          |
| `if/then/else`、动态依赖等条件结构                   | 校验器按方言验证；表单不能可靠投影的区域显式 `unsupported`      |
| TypeBox JS 扩展、codec、函数和非 JSON 值             | 不属于普通 JSON Schema 表单支持范围                             |

验证器支持的结构可以多于自动表单；完整支持列表必须由代表测试证明后写入发布文档。JSON Schema 的条件校验并不自动定义 UI 隐藏或切换规则，相关语义见 [官方条件 schema 说明](https://json-schema.org/understanding-json-schema/reference/conditionals)。

失败分为三个真实情况：

1. schema 或 metadata 声明非法：抛出可判别的 `SchemaFormError`，含 `code`、schema 位置、期待值和修正说明。
2. 声明有效，但字段结构无法可靠呈现：返回 `unsupported` 节点及原因，UI 保留数据并说明限制。
3. 表单值验证失败：由所选运行时校验器返回原生或 Standard Schema issues，Pluxel 映射为现有领域回执。

稳定原因码至少区分非法 metadata、方言冲突、缺失引用和不支持的结构。诊断不携带用户配置值、默认秘密或函数源码。未知 programming error 保留 cause，不以空 fields 伪装成功；合法空 object 则可以明确返回空字段列表。

`projectRawInput(schema, path)` 保留当前可判别结果，描述 string/number/boolean/json transport。两个适配必须遵守同一输入侧规则，路径不存在、分支歧义和不支持结构分别报告。库只描述 transport，环境变量取值、JSON 解码和覆盖优先级由 Host 执行。

## 元数据审查与 agent 使用

以现有 `FormMeta`、各类型 Meta 和真实使用点建立逐项映射：字段由哪个 renderer 使用、省略时如何决定、错误输入怎样定位。具体组件名称、样式 props、列数启发式和中文默认文案进入 Workbench。`section`、`span`、控件偏好、条目操作等可跨 UI 表达的语义留在包中。

已有文档指出 `objectMeta.columns` 当前未被 renderer 使用。实施时须用调用方证据决定实现其语义或删除该无效声明，不能继续导出一个看似生效的字段。`array.defaultItem` 是作者提供的新增草稿种子，添加动作才使用，不能冒充 config 缺省值或自动执行工厂。

每个入口的公开文档提供一条最短完整路径，以及紧随其后的常见失败。类型导出与 JSDoc 说明输入/输出、默认规则和适用类型；agent 能通过普通 `rg`、类型检查和运行样例定位入口，无需理解内部 walker 或这段设计对话。

验收使用真实任务：给端口加约束与 step、修正错拼 metadata、使用 TypeBox optional/enum、处理缺失引用、读懂 transform 前的输入，以及为字段实现一个本地 renderer。成功标准和比较方法见 [agent 验收](migration.md#agent-使用验收)。
