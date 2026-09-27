# 严格契约审查：实施记录与剩余验收

状态：主体迁移已提交；本页只记录验证结果和未完成的边界。当前 API、配置和操作说明分别以 [工程原则](../DESIGN_PRINCIPLES.md)、[系统边界](../PLUGIN_SYSTEM.md)、[工具链](../TOOLCHAIN.md)及 `docs/` 为准。原提案基线为 `0b0f42ed`，Workbench 故障修复基线为 `cee746d4`。本页不是另一份运行时规范。

## 已落地并验证

| 项目             | 结果与权威说明                                                                                                                                                                                                                                                                                                        | 证据                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| S01 持久数据     | 已有配置或状态文件损坏时拒绝 Host 准备并保留原字节；缺失文件仍使用初始值。见[运行服务](../../docs/reference/runtime-services.md)。                                                                                                                                                                                    | `e332705f`；Core 252、Host 138 项测试与类型检查。                                                                          |
| S02 workspace    | `pnpm-workspace.yaml` 是成员权威；选中成员的坏清单、错误 pattern 和扫描 IO 失败不会被当成完整成功。见[工具链](../TOOLCHAIN.md)。                                                                                                                                                                                      | `3fb8895d`；workspace 定向测试与 CLI 类型检查。                                                                            |
| S03 解析         | 普通未安装包仍是未命中；已发现的坏 package manifest、读取失败及 exports/self-reference 等失败保留 importer、specifier、conditions 和 cause。Host-dev 不借用父 package manifest。见[工具链](../TOOLCHAIN.md)。                                                                                                         | `3fb8895d`、`24c19977`、`4daae8a8`、`09c78fde`、`c374da37`；解析器 7 项和依赖图 lowering 36 项测试、chatbot 完整构建回归。 |
| S04 共享运行时   | publisher 和提供 target 的基础库声明 capnweb peer；build 验证作者声明，Vite/static 在改道前验证声明、实际版本与 import 条件，私有 RPC 不接管。四个 local-projects 已各自迁移和提交。见[插件包](../../docs/development/plugin-package.md)、[Workbench View](../../docs/workbench/view.md)、[工具链](../TOOLCHAIN.md)。 | `03ea4012`、`124e4065`、`b29ac48c`；准入与损坏清单回归、四个相关包类型检查、四个 local-projects 的 doctor 和全量类型检查。 |
| S05 制品         | Shell 使用固定入口与 publicDir，检查静态/动态 import、CSS 和资源闭包；坏 manifest 不以其他制品替代。见[独立宿主](../../docs/workbench/standalone-host.md)。                                                                                                                                                           | `32b4f8d9`；构建、发行和搬离仓库测试。                                                                                     |
| S06 显式输入     | Services preset 拒绝未知字段和非法 `workbench` 值；显式空白 `PLUXEL_STATE_DIR` 报错。见[CLI 工具](../../docs/development/tooling.md)。                                                                                                                                                                                | `d70f8e73`；定向测试与类型检查。                                                                                           |
| S07 资源 IO      | 真正未命中按路由返回；读取/权限错误保留服务端原因并返回 500。见[独立宿主](../../docs/workbench/standalone-host.md)。                                                                                                                                                                                                  | `32b4f8d9`；Services/Workbench 定向测试。                                                                                  |
| S08 dev 状态     | discovery 区分 `ready`、`updating`、`unavailable`，无 Host 时仍提供最近接纳结果；真实 Vite 启动失败后修复源码可恢复。见[开发控制台](../../docs/development/dev-console.md)。                                                                                                                                          | `a5040997`、`2f59a0fb`；控制台测试与真实 Vite 恢复 smoke。                                                                 |
| S09 factory 诊断 | 已知 target/复用/超时错误分别分类；未知异常保留服务端 cause，浏览器只得到安全 code 与关联标识。见[Workbench View](../../docs/workbench/view.md)。                                                                                                                                                                     | `62f23886`；Workbench 定向测试。                                                                                           |
| S10 已验证部分   | 官方 Vite 宿主中的源码 publisher、打包 Shell HTTP 入口、View RPC 和 session 释放已由临时隔离 root 的 smoke 覆盖。publisher 本身尚未以发行包消费。                                                                                                                                                                     | `cf0030e3`；installed Vite smoke；其余边界见下文。                                                                         |

上述测试数字是各批提交时的定向结果，不表示每一项都经过真实浏览器验证。项目级 `pnpm verify --concurrency=2` 已通过：治理、lint、格式、95 个 Turbo 类型/构建/测试任务和来源声明检查。

后续本地消费验证：chatbot 与 bot-new-omni 的 `pnpm verify` 通过；rhythm 修正五个清单的格式后，`pnpm verify`（含应用、前端、生产 smoke）通过。backend 对当前源码的 source build、治理、格式、lint、43 个类型/测试/构建任务和冻结发行物生产 smoke 通过；完整 `pnpm verify` 的首步 provenance 按设计拒绝旧 source lock 与本机未推送提交的不一致。四个项目均未改动真实持久数据。

## 审查后修正的判断

- 旧版 `plugin-deps` 构建钩子会移动作者维护的依赖字段并从既有生成事实推断删除。现在构建只验证编译事实对应的 provider peer/optional 声明，更新由编译器拥有的 metadata。普通构建不承担清单自动修复；版本选择仍由包作者与 pncat 管理。`workspace doctor --fix` 原先被写成拟议入口，没有可审查的全 workspace 编译事实与确定版本来源，不能仅为了交付一个开关而从安装树猜修复值。
- `environment.ts` 的官方环境解析、`config.ts` 的 saved/application 阶段、系统边界中的 owner/generation、可选能力和资源撤回原本已有明确契约。本轮保留这些设计，只补有反例的入口和诊断；没有证据支持将所有配置并入统一解析器，或将所有依赖改为 peer。
- 模块解析器的正常未命中与损坏的已发现 package 是两类事实。OXC 当前只提供字符串错误而非稳定错误码；边界分类依赖物理 package 与 resolver 输入证据，不用错误文案匹配。不能承诺识别每一种没有物理目录的 alias/tsconfig 内部失败。
- 清单完整性证明文件与引用存在，不证明浏览器执行正确；Vite 进程存在也不证明应用 ready。真实消费与开发状态各需自己的证据。

## 尚未完成的边界

1. **显式批量修复工具。** `workspace doctor` 仍只检查。若实现 `--fix` / `--fix --dry-run`，先由现有 inventory/编译事实形成字段、旧值、期望值、依据和冲突报告，再检查文件快照后写入、重查并报告部分完成。没有版本依据、角色不明或声明冲突时只报错，不猜版本、不迁移 Host 或私有 RPC。当前用户可按诊断显式修改清单。
2. **共享运行时的 Host 所有权检查。** 四个已知 local-projects 的最终 Host 已直接声明并安装 capnweb；目前准入主要检查 publisher 和它实际解析的模块，尚无适用于任意 Host 应用 package 的直接依赖声明校验。需要先确定应用入口对应的 package owner，避免把 Vite root 当成包 owner。
3. **打包 publisher、浏览器与发行路径的端到端验收。** 还需在实际浏览器中覆盖独立发布包 → 官方 Vite Host → Shell 打开 View → 读取 RPC → 关闭释放，并验证直连/代理与生产发行入口。临时 publisher 的官方 `pluxel build` 实验生成 `dist/index.mjs` 后，MF 类型生成报 `TYPE-001`、缺少 `@mf-types.d.ts`，制品终结据此拒绝；尚不能把该手写夹具当成产品回归，也不能宣称打包 publisher 已验证。现有 Services 独立安装 smoke 在可选 Workbench 阶段之前被 Elysia beta 的声明错误挡住。Node/Vite smoke、Shell HTTP 和 RPC 检查不能替代浏览器渲染、浏览器 WebSocket 或生产 UI 验收；下一步应使用可成功发行的真实 publisher 产物及浏览器环境保留最小反例与诊断。
4. **OXC 不带稳定错误码的歧义。** 对无物理 package 证据的 alias/tsconfig 失败，当前不能可靠区分普通未安装包。若上游提供稳定错误种类，可在 resolver 边界细化并增补实际消费反例；此前不靠 message 正则伪造分类。
5. **backend 来源锁迁移。** `local-projects/backend/pluxel.source-lock.json` 固定公开提交 `0b0f42ed`，当前本机注册的是本轮未推送提交。不要把别人无法取得的 commit 写入可复现性锁；待框架提交可获取后，使用项目已有 `source:install` 流程更新锁与隔离 checkout，再执行完整 `pnpm verify`。当前源码路径的单独验证结果见上文。

这些项目是实际未验证或缺少确定修复依据的边界，不改变已落地的契约。新增约束须说明权威输入、实际失败影响和验证入口，不新增平行规则、兼容开关或运行时隐式修复。
