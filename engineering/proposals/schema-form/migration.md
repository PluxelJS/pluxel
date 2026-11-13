# 迁移顺序与完成证据

状态：实施计划，尚未执行。当前交付仅为提案文件；包改名、代码迁移、服务操作与发布均属于后续实施。

## 已知消费者

以下来自 2026-11-13 的源码与 exports 检查。实施开始时重新搜索，避免把当时的清单当作永久全集。

| 使用边界            | 当前入口与文件                                                                                                                                        | 迁移要求                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 包构建与导出        | `packages/valibot-form/{package.json,tsdown.config.ts,vite.config.ts,src/index.ts}`                                                                   | 迁为 `packages/schema-form`，只保留公共模型及两个适配子路径 |
| metadata 与原始输入 | `src/core/{meta,fields,rawInput,schema,schemaMetadata}.ts`                                                                                            | 分离公共类型与 Valibot 实现，新增 JSON Schema 适配          |
| UI 与行为测试       | `src/web/`、`src/tests/autoForm*`、`arrayRenderer.spec.ts`                                                                                            | 移入 Workbench 内部表单，行为断言跟随消费者边界             |
| config 校验         | `packages/core/src/services/config/`、`plugins/composition/PluginConfigs.ts`                                                                          | Standard Schema 路径保持；增加明确的 JSON Schema 验证适配   |
| Host env/file       | `packages/host/src/{bindings,input-binding-contract,input-bindings}.ts`                                                                               | 类型、原始路径投影、声明身份与替换准入一并迁移              |
| 编译及 CLI 诊断     | `packages/rolldown/src/rolldown/plugins/{configSourcePlugin,staticConfigEnvironment,staticConfigEnvironmentSchema,staticConfigEnvironmentExample}.ts` | 认识新入口，保留 source 诊断与静态输入规则                  |
| Management 字段协议 | `packages/services/src/management/{api/presenters/configPresentation,web/protocol,web/validation}.ts`                                                 | 共用字段模型，更新 envelope 版本，移除重复字段语义          |
| Shell 配置          | `packages/workbench/shell/src/app/plugins/config/`、`app/forms/serverValidation.tsx`                                                                  | 内部 UI 接线、segment 路径、保存基线与并发不变量            |
| Content             | `packages/workbench/src/workbench/definition.ts`、Shell `WorkbenchContentSlots.tsx` 与 `presentationAdapter.ts`                                       | 共享模型及 UI，保留发布限制、action 和 display 行为         |
| Shell bootstrap     | `packages/workbench/shell/src/app/bootstrap.ts`                                                                                                       | 审查并移除无消费者的 schema vendor 全局                     |
| 文档应用            | `projects/docs/src/components/configuration-{schema,preview,playground}.tsx/ts`、`scripts/generate-playground-types.mjs`、Vite 与依赖声明             | 新 imports、类型资源、预览 renderer 和验证示例同步更新      |
| 作者与样例          | `plugins/{auth,redis,storage,wretch,otel,package-manager,render}/`、`projects/plugin-host/`                                                           | 默认迁移 Valibot import 路径；选择代表配置增加 TypeBox 样例 |
| 仓库治理            | `scripts/check-{repository-governance,source-declarations}.mjs`、`scripts/repository-packages.test.mjs`、依赖锁文件和任务图                           | 新包归类、exports、构建依赖和源码声明规则同步               |

源码搜索至少覆盖 `valibot-form`、`@pluxel/valibot-form`、`valibot-form/web`、旧目录路径、`__PLUXEL_SCHEMA_VENDORS__` 和 presentation DTO 名称。后者与路径类型的变更还需要按 exports 追踪真实调用方。

当前模板不一定直接使用表单包；生成项目的 AGENTS、CLI 模板和说明仍需纳入搜索。历史 changelog 保持其历史含义，活跃代码、教程和构建配置应全部使用新入口。

## 一条实施路径

### 1. 用代表样例固定公开面

准备一份 Valibot 和一份 TypeBox 的等价配置，包含默认端口、枚举、可空字段、嵌套 object、array 和 discriminator union。补充一个字符串到数字的 Valibot transform 样例，以区分输入草稿和解析输出。

在隔离原型中证明 typed metadata、字段提取、JSON Schema 校验桥、默认值和错误路径。用正式拟议 import 编写类型探针，不从内部函数绕过导出。验证通过后固定 [API 文件](api.md) 中的具体签名及首批支持矩阵，删除原型里的替代路线。

### 2. 完成一条窄的真实链路

把 TypeBox 配置用于真实 Plugin/Part 声明，通过工具链、Host config、Management presentation、Workbench 编辑、保存与回读。再验证 env/file 绑定作用于同一个声明对象及原始输入路径。

这条路径先暴露接线和语义问题，再扩展其他结构。验收必须看到原始保存输入和运行中输出分别符合预期，不能仅展示一个静态表单或 isolated test host 就声称在线配置可用。

### 3. 在同一迁移批次完成包与 UI 边界

移动共享模型与 Valibot adapter，加入 JSON Schema adapter。将 React/Mantine UI、第三方表单依赖和相关测试移入 Workbench 内部，接好 Config、Content 与 docs preview。

Services 与 Shell 同步采用公共模型，删除重复映射及旧包 imports。迁移所有已知作者、任务配置、类型生成与活跃文档。不保留 `valibot-form` 空壳、旧 `/web` 转发或两套字段 reader。

分步提交可以便于审查；最终接纳的源码和发行制品必须只有一套字段语义和生产路径。配置数据自身无需因包名改动重写，发现真实格式差异时用可审查的一次性维护转换处理。

### 4. 完成 UI 与独立发行验收

按下面矩阵运行与实际风险相称的类型、功能、浏览器和制品检查。同步正式文档后，为用户可见包变更添加 Tegami 记录。新包首次发布与受影响公共包的 bump 类型明确记录，版本和 publish lock 由 Tegami 管理。

独立安装通过是发布准备的一部分；本提案及本次文档工作不执行 npm 发布。

## 契约与运行验收

| 要证明的结果               | 最直接的证据                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| metadata 好写且能查错      | 真实类型探针：`stepp`、错误 `step`、string 上的 number metadata、optional/readonly/enum 保留、预声明变量的运行时检查 |
| 两种 schema 的公共含义一致 | 等价 schema 产生相同字段语义；只比较有意义的字段，不锁定内部遍历方式                                                 |
| 提取没有副作用             | default/transform/lazy 带计数或抛错函数，提取时不执行；数组新增种子只在用户动作时使用                                |
| JSON Schema 规则真实       | 固定方言、refs、nullable、required、additionalProperties、format 和组合结构的正反例；unsupported 有位置与原因        |
| 默认值符合契约             | 缺失会按显式策略补齐，非法值/空值保持错误，输入和 schema 不变，union 不猜分支，输出与类型一致                        |
| portable 模型可消费        | 序列化往返、未知 kind/metadata 拒绝、循环和预算拒绝；真实消费者不依赖源 schema 或内部 helper                         |
| config 完整可用            | Plugin/Part 初始化、validate、patch、reset、来源覆盖、运行中 update、replacement 绑定检查和保存回读                  |
| 输入路径不会串字段         | `a.b`、字符串 `0`、数组 index、斜线 key 的错误和修改都到正确位置；不能无损绑定时明确保留只读                         |
| 未编辑数据保留             | unsupported 子树、隐藏字段、未知但允许的属性，以及集合整体替换的保护场景                                             |
| UI 不覆盖新输入            | 同 owner 双文档、保存期间继续输入、旧响应、失败重试、外部刷新 dirty form、保存全部的跨 section 错误                  |
| Content 迁移守约           | unsupported action publication 拒绝；data default/transform/password 限制；错误保留草稿；关闭后 late result 不更新   |

现有证据入口包括 `packages/valibot-form/src/tests/`、`packages/services/tests/management/config-presentation.test.ts`、`packages/workbench/tests/workbench-content-presentation.test.ts`，以及 Shell 的 `web/config-form-loop.test.tsx`、`workbench-config-save.test.tsx` 和 `workbench-outline.test.tsx`。迁移测试时保留这些用户行为，不为旧文件布局保留测试兼容层。

## UI 的实际验收

在真实 Workbench 验证配置页与 Content form。选择正常宽度、窄分屏和低高度容器，检查长中文标签、多行错误、深层集合、可空值、只读区域和 discriminator 切换。记录截图并检查键盘 focus、目录定位、滚动和集合操作。

配置测试要同时观察 Host 回执与浏览器草稿；截图不能证明保存正确，后端成功也不能证明 UI 没有丢失后续输入。docs preview 应使用迁移后的同一实现，并单独通过项目类型检查和构建。

开始修改运行应用源码前，按 [开发控制台](../../../docs/development/dev-console.md) 选择实际 profile 并暂停 HMR，完成检查后 apply，核对批次和应用报告后按原模式恢复。浏览器检查使用仓库已有服务和截图流程，不另起一套后台进程。当前提案编写无需操作服务。

## 独立包与依赖验收

从实际 tarball 创建工作区外的消费者，使用发布 exports 和生成的类型声明。分别验证：

1. 仅安装 `@pluxel/schema-form`，根入口与 `/json-schema` 可导入、解析字段模型并运行；依赖树不拉入 React、Mantine、TanStack Form、Pluxel Host 或 TypeBox 编译器。
2. 按文档安装 Valibot 后，`/valibot` 可用。Valibot 以适配入口需要的 optional peer 声明，根入口不间接 re-export 它。
3. 安装 TypeBox 编写示例，helper 保留推导。普通 JSON Schema 输入不要求安装 TypeBox；库间静态标记不能出现在发布的字段模型里。
4. 用最小 DOM 或其他独立 renderer 展示和修改代表字段，读取提交值与错误。此样例属于验收消费者，不增加另一个正式 UI 产品。
5. Workbench 的内部 UI 构建在真实分发条件下通过，React/Mantine 仍按项目 Provider、CSS 和模块共享约束工作。

`schema-form` 裸名在本次调研时已有 npm 包，目标名称为 `@pluxel/schema-form`。发布前仍须通过实际组织权限和 registry 准入确认名称，不将一次查询当成发布保证。

## Agent 使用验收

给消费 agent 任务、公开 README、exports、类型检查和普通源码查询工具，不提供设计对话或作者的内部解释。至少覆盖：

- 选择正确子路径，为端口添加约束和展示步长，并说明两者分别由谁执行。
- 将现有 Valibot 示例换成 TypeBox 的等价作者写法，保留缺省、optional 与 enum 类型。
- 修正一个错拼 metadata、一个缺失 `$ref` 和一个不支持的字段结构。
- 解释 transform 前的草稿与 config output，正确处理缺失、`null` 和 reset。
- 根据公共字段类型为一个已知 kind 写消费者 renderer，不读取独立包私有源码。

记录是否完成、修复次数、查阅入口、工具调用、token 与耗时。先要求任务正确完成且失败能定位；只有固定模型、工具权限与任务条件做对照后，才声称提高 agent 效率。实现阶段执行这组验收，本次提案不把设计判断写成已测结果。

## 文档与停止条件

实施后更新 `docs/plugin-development/configuration.md`、Workbench 表单说明与 playground、包矩阵、排错文档，以及 `engineering/{CONFIG,UI_LIBRARY,FRONTEND,WORKBENCH}.md` 的相关段落。现有 `docs/workbench/valibot-form.mdx` 页面路径先保留并调整标题与内容，避免无必要的链接迁移；新包 README 承担独立消费者的安装及完整示例。

完成条件是：公开入口与类型可用，实际配置和 Content 路径守约，UI 迁移通过，独立 tarball 可消费，已知引用和正式文档一致，旧实现已删除。完成后将剩余判断移到正式文档，并按 [提案维护规则](../README.md#维护规则) 清理本目录。

本次提案交付只检查文档结构、源码依据、相对链接和 diff；尚未运行上述实现验收，也未修改生产代码。
