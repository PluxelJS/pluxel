# Pluxel 集成与内部表单 UI

状态：设计提案，尚未实施。公共字段模型由 [API 设计](api.md) 拥有，本页规定 Pluxel 如何使用它。

## 配置的数据校验仍走 Standard Schema

JSON Schema 描述、字段计划和可执行验证器有不同职责。`configs.use()` 继续接受 `StandardSchemaV1`，Core 继续维护解析后 snapshot、revision 与 generation 注入。JSON Schema 作者需要一个明确的适配入口，把验证、默认值策略和输入描述绑定到同一份声明。

建议在 Pluxel 的配置领域提供独立子路径 `@pluxel/core/config/json-schema`，暂定函数名 `jsonSchema()`。它返回同时提供 Standard Schema 验证与 Standard JSON Schema 描述的对象。该入口不从 Core 根入口重新导出，使用 Valibot 的应用不因此加载 JSON Schema 验证器。

以下是目标用法，入口、默认值实现和类型签名仍待原型验证：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { jsonSchema } from '@pluxel/core/config/json-schema'
import { withFormMeta } from '@pluxel/schema-form/json-schema'
import Type from 'typebox'

const Input = Type.Object({
	port: withFormMeta(Type.Integer({ minimum: 1, maximum: 65535, default: 8787 }), {
		title: '监听端口',
		section: 'network',
		number: { step: 1 },
	}),
})

export const Config = jsonSchema(Input, {
	dialect: '2020-12',
	defaults: 'apply',
})

@Plugin()
export class Gateway extends BasePlugin {
	private readonly config = this.configs.use(Config)

	protected override init() {
		this.ctx.logger.info('监听端口', { port: this.config.port })
	}
}
```

适配对象既是配置验证的声明，也是 presentation 和部署绑定取输入描述的来源。后者读取输入侧 JSON Schema；不能从已解析 output 反推输入结构。现有 Valibot 继续直接提取，避免转换过程丢失 pipe metadata。

[Standard JSON Schema](https://standardschema.dev/json-schema) 提供输入与输出描述接口，但它与 Standard Schema 的验证接口分别承担职责。适配需要同时实现二者，并确保 `jsonSchema.input` 与 `jsonSchema.output` 分别表达实际语义。将 converter 接入工具链时属于显式描述转换，不执行 validation、default 或 transform。

数据校验实现优先验证仓库已采用的 TypeBox 1.x 能力，使用严格的检查和 issues 路径。当前版本的 [`Validator`](https://raw.githubusercontent.com/sinclairzx81/typebox/1.4.3/src/compile/validator.ts) 提供 `Check`、`Errors`、`Default` 等方法；它本身没有这里需要的 `~standard` 接口，不能把 `Compile()` 的结果直接宣称为现有 config 输入。正式选型以固定版本、方言、格式验证、非 JIT 环境和错误路径的实验结果为依据，表单包不承担这个依赖。

TypeBox 已知 schema 的输出推导应保留 `Static` 含义，optional 字段不能因带有 `default` 就被无依据地断言为 required。外部加载的宽类型 JSON Schema 返回诚实的宽类型，不提供凭空保证输出的 `jsonSchema<T>()` 断言口。默认填充前的输入推导、env mapping 补全及 converter 的 required 处理是原型的重点；满足这三项后再固定签名。

## 默认值、原始输入与失败

适配的 `defaults` 缺省为 `annotation`，遵守 JSON Schema 的标准含义；Pluxel 配置教程需要缺省填充时显式写 `defaults: 'apply'`。两种模式均执行完整验证。

`apply` 模式只填充缺失属性，不将 `null`、空字符串、`false`、`0` 或非法显式值改成默认值。先复制本次 effective input，再补齐并校验，输出作为 normalized snapshot；原始输入、保存记录和 schema 对象保持完整。默认对象也须复制，不能让多个解析共享可变引用。

第一版填充策略限于可明确定位的 object properties 及其已存在或有显式整体默认值的子对象。union、条件、交叉和引用中的默认值必须证明选择无歧义；不支持的位置在声明接纳时报告。不会因为缺少一个父对象就猜测并创建整棵子树，也不会选择第一个 union 分支凑出成功值。完整数据校验继续由原生验证器执行，默认值补齐规则由该 Pluxel 适配唯一维护。

自动类型转换、删除额外属性、codec 执行和任意函数 transform 不属于该 JSON Schema 配置入口。JSON Schema 的额外属性是否允许由 schema 决定；允许的值保留，禁止的值报告错误。需要 Valibot 转换的现有声明继续走原生 Valibot 路径。

Host 继续按 [现有来源优先级](../../CONFIG.md#static-startup-config) 合成 input，再调用一次完整验证。schema output 不写回保存层。validation、persistence、desired/applied revision 和运行中通知的现有阶段继续分别报告。

默认值语义依据 [JSON Schema annotations](https://json-schema.org/understanding-json-schema/reference/annotations)。所选验证库的补齐功能必须遵守上面的 Pluxel 规则；不能仅开启一个会同时清洗、转换的宽松 parse 选项。

## Host、工具链与管理面

| 所有者             | 本次适配                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Core config        | 接纳标准校验适配，保留 object output、JSON 值和深冻结约束；PluginPart 仍聚合为同一个 node record               |
| Host bindings      | 移除 config 对 Valibot `kind` 的硬编码，按已接纳的 schema 来源调用原始输入投影；保留同一 schema 对象的声明校验 |
| Rolldown / inspect | config lowering 继续记录声明和 source；环境输入诊断支持两个适配入口，不通过执行作者业务代码获取字段            |
| Management         | 为每个实际 declaration 生成字段模型，组合 General/Part envelope，映射校验结果                                  |
| Shell              | 读取已校验字段模型与 Host input snapshot；编辑 managed input，保存时只提交明确变更                             |

typed `envBinding`、`fileBinding`、绑定路径校验、replacement 准入和环境示例生成必须同步适配。config 与 Vault 的 schema 参数应拆开表达：本次新增 JSON Schema config 支持，不因此放宽 Vault 的记录 key、生命周期和安装契约。

Services 直接组合独立包的公共字段类型及 parser，删除近似 `ConfigPresentationFieldV1` 与 `FieldNode` 之间的逐字段来回复制。保留真正有领域含义的 section path、field owner、来源、readonly、managedRevision 等外层数据。

字段模型变化时更新配置 presentation envelope 版本；Content 的 presentation 协议也按实际变化更新。在同一个发布批次迁移生产者和消费者，版本不符显式拒绝。字段本身的语义由独立包维护，Pluxel 的消息版本和 budget 由协议拥有者维护。

当前 Config issues 在投影时将 path 全部转成字符串，浏览器又猜数字索引。这次路径契约审查应保留字符串 key 与数组 index 的区别，并同步 Host/Management 类型、parser 和 Shell 映射；不能让新的无歧义模型在 RPC 中再次丢失信息。外层结果分类和保存回执保持原义。

## Content 使用相同字段模型，保留自己的接纳规则

共享模型用于现有 Content action 的 dialog/embedded form 与 data 展示。Content 当前公开 schema API 仍以 Valibot 为准；本次迁移不自动宣称所有 Workbench schema API 都已支持 JSON Schema。

- Config 可以保留部分只读的 unsupported 区域；必须完整可填写的 Content action input 在 publication 时继续拒绝不支持结构。
- Content data 保持 transform-free、无 default/lazy、无密码值展示的限制，不能以更宽的通用字段类型放松发布检查。
- action validation/domain/unexpected failure 保留草稿；成功按原流程清理，close/owner 撤回后的结果不回写 UI。
- action 仍由 Content 服务端拥有，字段包不增加动作 DSL，也不把 handler 或 closure 放进字段计划。

既有 [Content trust boundary](../../WORKBENCH.md#content-trust-boundary) 与 [presentation 测试](../../../packages/workbench/tests/workbench-content-presentation.test.ts) 是迁移基线。后续如扩展 Content 的 schema 作者入口，应在这条边界单独验证。

## UI 实现的归属与注册

将 `packages/valibot-form/src/web/` 的通用表单实现迁入 `packages/workbench/src/internal/forms/`。Shell 的 Config、Content 与 docs preview 共用这份实现，通过明确标记为内部的 `@pluxel/workbench/internal/forms` 入口引用。它不属于独立表单包，也不作为第三方 Plugin 的默认 UI SDK。

`AutoForm` 只接受公共字段模型和明确的初始草稿；schema 提取、默认值计算、运行时验证均由上游调用方执行。保留现有 `AutoForm.Fields` 等仍有消费者的组合能力，按真实调用点收缩 props。内部可以继续使用 TanStack Form，schema-form 的类型不引用它。

Workbench 用普通、类型完备的组件表注册渲染器，示意如下：

```ts
const renderers = {
	string: StringField,
	number: NumberField,
	boolean: BooleanField,
	picklist: PicklistField,
	array: ArrayField,
	record: RecordField,
	object: ObjectField,
	union: UnionField,
	unsupported: UnsupportedField,
} satisfies FieldRenderers
```

`FieldRenderers`、React props、数组动作和字段绑定都由 Workbench 内部定义，按 node kind 收窄类型。表在表单装配时传入并保持稳定，不创建跨进程注册服务或可变全局 registry。外部独立消费者可以使用自己的映射方式，无须实现一套 Pluxel React 协议。

注册表只选择呈现实现，不修改字段类型、约束、可编辑性或保存路径。合法但当前 renderer 未实现的控件偏好需要可观察的限制；不能悄悄丢掉配置项并显示为成功。未知 kind 在字段协议校验时拒绝，已知 `unsupported` 交给只读 renderer。

Mantine 继续是第一方 UI，Provider、主题与 Core CSS 规则遵循 [UI Library](../../UI_LIBRARY.md)。独立包移除 React、Mantine、TanStack Form、图标和 DnD 依赖；这些依赖随实际使用者进入 Workbench。原有 `__PLUXEL_SCHEMA_VENDORS__` bootstrap 全局在确认无消费者后删除，正常 Shell 不需要执行 schema source。

## 内部 UI 的重新适配

围绕“找到字段、理解当前值、修改并确认采用”整理界面，沿用 [Workbench 交互规则](../../WORKBENCH_DESIGN.md)。

| 用户任务       | 目标交互与检查                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| 找到配置       | General/Part 保存单元清楚；section 作为文档内分组，本地目录只定位本实例                              |
| 理解当前值     | 展示 managed draft、有效输入来源和目标输出的区别；继承值不自动写进草稿                               |
| 清除或恢复继承 | 缺失、`null`、空串、`false`、`0` 各有真实含义；恢复继承生成 remove，而非写一份默认值                 |
| 修改普通字段   | label、说明、控件和字段错误形成稳定顺序；数字的暂态输入可编辑，避免每次输入立即破坏草稿              |
| 修改嵌套集合   | array/record 提供清楚的新增、移除、排序和键错误；原子替换前保护未知或只读子值                        |
| 切换 union     | 使用确定的 discriminator；共享字段保留，当前活动分支之外的草稿仅在本表单内缓存，提交不夹带失效分支键 |
| 保存并处理失败 | section 保存与保存全部共用现有提交协调；错误可定位，失败保留草稿，成功状态区分已保存与已应用         |

结构型字段优先顺序阅读；列数由当前容器宽度与字段复杂度决定，窄容器回到单列。深层 object/array/union 使用紧凑分组，避免层层卡片和不断缩窄的输入区。显式 metadata 的展示偏好与自适应规则需要在内部 UI 文档说明，独立包只携带意图。

原始 schema 描述保持稳定。来源、继承值和目标输出通过 Workbench 字段上下文呈现，不反写为另一份公共 metadata，也不重复建立配置状态库。

所有控件保留可访问名称、错误关联、键盘操作和 focus；排序有键盘路径，不能只依赖拖拽。长标签、多行错误、只读和 unsupported 状态均纳入真实浏览器检查。

## 保留的状态与资源边界

[现有配置表单规则](../../../packages/workbench/shell/src/app/plugins/config/README.md)继续决定状态所有权：每个 section 有独立 Form、saved baseline 和撤销；布局分组不合并它们。保存全部捕获所有参与草稿并提交一个 patch，既有同步 admission guard 防止重复写入。

只有响应仍属于同一个表单实例、owner 和提交快照时才可更新 baseline；保存期间的新输入继续保留。外部 snapshot 只更新 clean form，dirty draft 保持原基线。两个同 owner 文档具有独立草稿与 DOM anchors。

卸载、owner 切换及 Content close 清理各自订阅和资源，晚到结果只结算、不更新失效页面。正常配置提交验证一次；renderer 不另起轮询、连接或隐式自动保存。

docs playground 改为显式提取字段，再交给同一内部 UI。它自己的作者代码预览与校验由 playground 管理，不把执行源代码能力带入普通 Workbench。类型声明资源、导入映射和预览示例需要一起迁移。
