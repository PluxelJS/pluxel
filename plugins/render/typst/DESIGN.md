# Typst 文档运行时设计

`@pluxel/plugin-typst` 是 workspace 内的 private 插件。公开调用、输入契约与预算由[用法文档](../../../docs/plugins/rendering/typst.md)维护。

前端通过独立 `/browser`、`/tiptap`、`/tiptap/react` exports 消费共享能力，公开用法见[区域编辑](../../../docs/plugins/rendering/typst-editor.md)。Studio 是主要消费者，Monaco 及其 Vite 接线由应用持有；根入口和 `/template` 契约保持不变。

## 边界

TypstPlugin 是 native compiler 的唯一插件所有者。无状态 `renderSvg(source, options)` 供数学扩展与应用复用，完整文档编辑使用 `open()`；两者共享包内固定 native binding 和字体读取，按所需状态选择执行模型。

业务在输入前验证数据。核心只内置 JSON 编码，其余格式接受用户已编码的文本、字节或真实文件；文件表同时表达逻辑路径与来源，没有额外 Schema、Codec 或输入声明层。

Template 是普通 root/entry 配置。Session 固定字体快照，串行接纳完整输入文件表与可选模板树替换，持有最新成功产物并负责清理。应用拥有通信与归档，Preview 只消费产物。

## 执行路径

```text
renderSvg → shared Workers admission → bounded UTF-8 source / portable fonts
          → one per-job native compiler → caller-owned SVG bytes
open → 快照本地模板与可移植字体 → 分配有界 session
update → session 队列 → 准备动态文件 / 可选模板替换
       → session 专用 Worker → 复用 NodeCompiler、同步 shadow VFS delta
       → 同 document 导出 Vector/PDF/源码与标题坐标 → 发布成功修订
renderPage → 同 session 队列 → 校验 retained revision → bounded PNG / pixel crop（不编译）
exportPdf → 校验 revision → 返回独立 PDF 副本
close → 撤销接纳 → 终止专用线程并确认退出 → 清理私有资源
```

NodeModules 负责正式构建制品定位和替换生命周期；每个 session 至多一个独立 Worker，maxSessions 是线程上限。通用 Workers 没有线程亲和契约，因此此有状态计算不借用无状态任务池。

无状态 SVG 使用 `runPrepared()`，不另建队列或线程池；源码计量和字体读取在获准执行后进行，返回前检查 output bytes。请求采用 `settlement: 'execution'`，caller/provider 关闭均取消并等待执行结算，不持有会话。SVG 源码是可信完整 Typst 文档，受限公式语法归数学扩展所有。

Worker 保留 NodeCompiler、最新成功 document 与文件内容索引；同一私有文件快照中未变化的文件不重复读取，变更调用 mapShadow、删除调用 unmapShadow。每次 compile resetRead 刷新读取缓存，native memoized 计算仍保留；evictCache 按年龄清理，不代表 native RSS 硬上限。字体变化由调用方关闭并重开 session，避免同名字体缓存串扰。

取消在途 native 计算需要终止线程并关闭会话，不能在已销毁线程上继续更新。调用方可重新 open。普通编译诊断不关闭会话；修复源码后可在原会话继续。无法确认退出时保留目录并报告 EXECUTION_UNSETTLED。

原生绑定固定 typst.ts 源码版本，使用本包 `native/` 中可审查的最小补丁暴露 `NodeTypstDocument.navigation()` 与 `renderPage()`。它直接遍历本次 document 的 frame/span 和 introspector；不建立第二个编译器、语言服务或业务监听端口。构建产物由包携带，Plugin 从自己的包位置解析 native 路径并作为内部输入传给 Worker；缓存中的 extracted artifact 不自行猜包位置，不修改 node_modules，也不在主线程加载 binding。

## 资源与修订

模板在 open 复制，update.template 可提交完整替换；动态输入在 session 排队后写入 staging，准备完成再替换 inputs 目录。文本/JSON 分块编码，文件走磁盘复制或 copy-on-write clone，Worker 消息只传路径和小型配置。逻辑完整替换不要求输入原样经过跨线程 clone。

每次任务返回有界 Vector/PDF、源码定位信息与诊断。成功替换当前修订；失败保留旧产物。exportPdf 在调用时取得对应 PDF 引用，后续更新不影响该导出。关闭、调用方停止和 provider 替换共用幂等清理。

固定范围是本地模板目录、动态文件与可移植字体。上游系统字体及 Typst 包加载仍是部署环境输入，不宣称完整可复现或安全沙箱。

## 前端子入口与区域生成

`/browser` 只依赖纯 preview/diagnostic 契约，拥有命中算法、SVG CTM、普通点击过滤、页面/目录跟随、滚动与高亮。View 只持有调用方提供的 renderer；销毁 View 不关闭共享 renderer。同步状态回调可以销毁 View，后续导航发布、高亮与计时器必须在同一调用中停止。宿主拥有源文件与客户端草稿当前性、可见 pane 选择及异步打开后的复核，不向 View 注入整个应用 controller。

`/tiptap` 无 DOM 导入，使用官方 Tiptap 3 schema 与 MarkdownManager；没有第二份正文 AST。`validation.ts` 先检查 raw JSON/属性/表格，再让 schema 检查内容结构；原始输入不能依赖规范化丢弃内容后通过校验。`serialize.ts` 显式覆盖持久化节点与 Mark，生成 `_editor/regions/*.typ`、`/inputs/editor/data.json` 与同客户端修订映射。字段路径按编译时的实际父值解释数组或字典访问，保证纯数据变化无需重新生成模板；重复表头不能覆盖正文单元格。业务扩展有属性时必须提供值 validator；无 serializer 不接纳。HTML 输入先检查原始标签和属性，避免浏览器修复或 ProseMirror 规范化导致静默丢内容。

`base-extensions.ts` 的 `createEditorExtensions` 仅组合官方扩展；`extensions.ts` 的 `createTypstExtensions` 保持字段聚合入口，再加入宿主扩展。`TypstTableStyle`、`TypstTemplateBlock` 和 `TypstSource` 分别显式安装，两个工厂均不隐式开放。卸载后不自动投影已有 JSON；属性或节点的转换由宿主明确处理，不能依赖 schema 丢弃内容。

`blocks.ts` 持有组件定义、实例属性和源码块准入。宿主定义拥有模板源码、默认插入参数及属性 validator；草稿只保存实例 ID、模板引用、props 和 dataPath。`serialize.ts` 按原生 AST 顺序 include 每实例独立的 `_editor/blocks/<region>/<id>.typ`，参数与绑定位于输入 JSON，因此纯数据变化不改模板。区域内实例 ID 跨两种节点唯一，防止生成文件碰撞；移动保留 ID，复制分配新 ID。源码块显式授权用户编写 Typst，沿用宿主编译器资源与执行政策，不构成代码安全沙箱。普通 Markdown typst 围栏始终由官方 codeBlock 处理；两种原子节点的 Markdown 导出都明确有损。

`table-style.ts` 持有安装选项及连续完整表头判定，原始 JSON/HTML 准入、DOM decoration 和 Typst serializer 复用这些规则。扩展仅增加 table 属性、选项准入与 decoration，保留官方 TableKit 的结构、命令、选择和 resize NodeView。模板拥有默认样式和逐表覆盖范围，草稿只记录逐表选择；继承且无默认值时不生成额外 Typst stroke，编辑 DOM 回退网格。`grid-open-sides` 使用官方 `TableMap` 求合并单元格的真实左右边界，再标记 decoration；Typst 按网格坐标与 colspan 生成单元格各边 stroke，保留内部网格和上下外框。不能用 DOM first/last-child 判断 rowspan 下的边界。表头跨行合并穿过边界时不生成重复表头或三线表分隔线。JSON 保留显式样式，Markdown 不能往返该属性，导出诊断和候选复杂内容检查必须反映损失；HTML 只承诺属性重入，不承诺 decoration 外观或最终分页交付。

生成映射使用原生 ProseMirror UTF-16 位置，递归记录字符、原子与嵌套块。序列化过程的临时锚点在输出前移除，允许自定义 serializer 重排或重复 `context.children` 结果而保留来源；不会拆散字符串破坏排版塑形。native 将字面量解码后的 UTF-8 字形偏移还原为源码范围；计算表达式保留整体来源。代码块使用原生 raw 字面量以区分重复行。组件独立文件区分同模板的多个实例；源码块映射额外记录 `sourceStartLine`，反向查询去掉数据前缀后返回原始 source 行列。具体精度边界和宿主点击时序见[定位契约](../../../docs/plugins/rendering/typst-editor.md#预览与定位)。

`/tiptap/react` 是同一契约的普通消费者，提供 dataField NodeView 与原生 Editor 控件。`blocks-react.tsx` 为已安装原子节点提供同一 NodeView 和独立 `TypstBlockPicker` 插槽。卡片只常驻名称、原生 drag handle 与块菜单；顺序使用官方 drag/drop，复制使用 `insertContentAt` 并分配新 ID，删除使用 `setNodeSelection().deleteSelection()`，均沿用原生 history，不添加并行排序或剪贴板协议。标题/空白点击经控件及拖选过滤后选中节点并调用宿主 `onReveal`。

模板参数和绑定数据只读展示，绑定值读取已有 `TypstDataProvider`，不复制到节点属性；宿主参数表单直接组合官方 `updateAttributes`。仅源码保留局部编辑状态，显式应用才提交原生 transaction。源码导航通过当前节点及 `typst-navigation` 元数据展开源码；未应用修改与已编译源码不一致时保留修改并提示。

宿主数据更新只影响 Context，不触发文档 transaction；每个区域保留独立 Editor/history。受控粘贴在同一原生 transaction 中设置 `closeHistory` 与 `paste` / `uiEvent`，一次撤销只移除本次粘贴。准入插件对最新规则与 editable 权限检查，外部 commands 也不能绕过。`candidate.ts` 在准备/提交时均严格检查版本与权限；可选 range 必须覆盖完整、非空顶层块，在目标范围做 Markdown 往返检查，再校验合并后的整个区域。一次 transaction 只替换目标范围，外围复杂节点原样保留；范围本身包含复杂内容时明确拒绝，不自动重定位过期范围。

`tiptap/ui.tsx` 组合分组工具栏、段落类型、文字/表格上下文菜单与 slash 插入。文字和表格浮层复用官方 React `BubbleMenu`；文字格式条由右键或键盘菜单键显式打开，不随文本选择自动出现。文本右键命中原选区时保留范围，命中外部时移动 caret；只读、IME、源码输入与卡片数据文本保留原生菜单。表格菜单接受右键、键盘菜单键和表边入口，在 `TextSelection` 时复用文字格式控件，同面板保留表格属性和结构操作。表格结构命令属于官方 TableKit，`TypstTableStyleControls` 仅在样式扩展安装时贡献外观选项。Slash 先用官方 CommandManager 对借用的原生 state 构造事务并按同一准入规则预演，提交时再检查；删除查询与插入共享一次事务，宿主命令仅组合 chain。UI 不维护另一份正文或历史，IME 期间不拦截插入键。`/tiptap/style.css` 是独立资源，由 tsdown 的 copy/customExports 同时维护开发和制品入口，JS 导入不附带 CSS 副作用。

`tiptap/table-style-controls.tsx` 独立读取已安装扩展的选项，只在选区属于同一张表时显示固定属性行。它在点击时再次检查权限、组合输入和允许值，使用原生 transaction 按精确位置修改当前表格属性并保留选区，避免对嵌套表格批量更新。样式通过官方 wrapper 的 decoration 标记生效，不依赖区域组件；只读与普通官方 Editor 使用同一外观规则，辅助虚线仅用于聚焦编辑。

`tiptap/typography.tsx` 在独立排版行组合官方 TextStyleKit 的字体、绝对字号、前景与背景颜色命令；宿主声明可用字体，不引入字体加载器或第二份格式状态。四项属性仍在原生 `textStyle` Mark 中，`text-style.ts` 共享原 JSON、HTML 原声明和 Typst 输出的值规则；HTML 仅投影官方 parser 对缺失属性产生的空值，显式无效声明先拒绝。生成器使用 `text` / `highlight`，Markdown 导出和候选沿用实际往返的复杂内容判定，避免以无格式文本替换带排版的正文。

Tiptap 系列统一为已验证的 3.32.0，身份通过 optional peers 共享；MarkdownManager 的直接 `marked` 依赖与该安装版本一致，避免私有类型及 tokenizer 实例混用。所有前端入口分别构建 JS 和声明，不靠 tree shaking 或 skipLibCheck 隔离；根、template、browser 不静态导入编辑器。包不包含 Monaco、Studio 或 Workbench 前端依赖。

区域配置、原始业务数据、权限与存储均由宿主持有。Studio 的 `.editor.json` 绑定源码修订，可选顶层 `table` 与 SDK 扩展选项同名同义，由 `studioEditorConfig` 显式安装扩展；独立 consumer 也显式安装。InputStore 以同一带条件版本的草稿保存 raw data 与区域 JSON；parsed data 只属于编译结果。生成文件只写入文档私有临时树，不污染共享源码缓存；正文变更使用 update.template，纯数据变更复用模板。实现位于 Studio `backend/editor-config.ts`、`documents.ts`、`inputs.ts`；不扩展 QuickJS 模块白名单或文档定义对象。

## 实现入口与验证

| 文件                      | 职责                                                     |
| ------------------------- | -------------------------------------------------------- |
| src/index.ts              | Plugin、配置、依赖与 owner 归属                          |
| src/session.ts            | 会话队列、修订、取消与文件寿命                           |
| src/resources.ts          | 路径、编码、快照与输入预算                               |
| src/native-client.ts      | 专用线程、取消及退出结算                                 |
| src/worker.ts             | native 编译、同修订导出与诊断                            |
| src/svg-worker.ts         | 每任务无状态源码编译与 SVG 导出                          |
| src/operation.ts          | 会话与 SVG 共用取消/deadline 参数                        |
| src/native-binding.ts     | 包内固定 NAPI 制品加载                                   |
| native/                   | 原生补丁与可重复构建                                     |
| src/browser/preview.ts    | 浏览器渲染、过期结果与释放                               |
| src/browser/navigation.ts | 普通源码位置、页面命中与重复范围选择                     |
| src/tiptap/               | 区域校验、官方扩展、Typst生成与映射、Markdown/HTML、候选 |
| src/tiptap/react.tsx      | React字段显示、原生区域Editor与可组合控件                |

验证覆盖资源边界、session 状态、真实 Plugin lowering/Worker artifact、浏览器 Renderer 和包入口。性能结论以代表性输入测量为准，不把资源字节上限作为 native 内存保证。

`tests/tiptap-native.test.ts` 与 Studio `tests/editor-backend.test.ts` 使用真实 native 预览/PDF。`tests/tiptap-blocks.test.ts` 覆盖实例隔离、数据更新复用模板、重排及源码行列映射、编译失败恢复和局部候选保留原子节点；`tests/tiptap-table-style.test.ts` 用合并表格的 native PNG 对照验证无左右外框。Studio `tests/desktop.mjs` 验证正常应用消费路径。独立 `tests/consumer.mjs` 把实际构建制品移出工作区，分无可选依赖、Tiptap、React 三阶段安装/类型检查/构建，再用真实浏览器与会话编译验收；不安装 Monaco，不使用源码 alias。它不改变本包 private 发布身份。

体验页的正文/数据/模板/候选四个标签、示例 schema 与报告组件定义属于 consumer；SDK 提供编辑与预览能力。标签切换保留已挂载 Editor，预览导航先打开所属标签再定位；Studio 仍拥有自己的工作区装配和源码编辑器。
