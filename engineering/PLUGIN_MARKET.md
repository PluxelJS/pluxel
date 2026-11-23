# 插件市场设计

市场回答“有哪些包、哪些发行已经检查过”。应用的 Package Manager 决定“这个宿主可以安装哪一版”，并发布受管入口。Host 发现入口后报告实际加载的插件节点及运行状态。三个阶段分别使用目录记录、安装回执和生命周期报告。[市场服务](../projects/plugin-market/README.md) · [包管理器用法](../docs/plugins/package-manager.md)

## 包身份与镜像

包以 `(registry, name)` 标识，发行再加精确版本。Workbench 的选择还记录 `marketId`，以便回到提供检查记录的目录。两个私有 registry 即使发布了同名同版本的包，也各有自己的卡片、检查记录和摘要。

| 配置                                        | 控制的读取                                                                                   | 对包身份的影响                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| 应用的 `markets[].url`                      | 读取主站目录或只读快照镜像，搜索和筛选由该目录执行                                           | 镜像保留快照中的原始 registry          |
| 市场来源的 `mirror`                         | 从公共 npm 镜像读取浏览元数据、标签和归档；精确发行的完整性和 attestations 声明仍向 npm 获取 | npmmirror 等镜像沿用公共 npm 坐标      |
| 应用的 pnpm registry、scope 和 `npmMirrors` | pnpm 按 scope 或默认配置解析和下载；`npmMirrors` 声明哪些下载地址可用于核对公共 npm 发行     | 独立发布者的 registry 作为单独来源登记 |

主站从 D1 读取当前可见的目录。只读镜像按 ETag 同步公开快照，在一次 SQLite 事务中替换数据；同步失败时继续提供上一次成功的目录。[来源配置](../projects/plugin-market/README.md#本地运行与来源配置) · [镜像部署](../projects/plugin-market/README.md#只读镜像)

## 从目录到精确发行

`observe` 保存 registry 声明的 dist-tags、说明和 README，并记录 `metadataVersion`。`refresh` 针对精确版本核对归档 SHA-512、包名、版本、公开文件和依赖，通过审核后写入发行记录。概览的 **Requirements** 只采用与 `metadataVersion` 匹配的已检查发行。这样即使 `latest` 已经前移，用户仍能区分新版 README 与旧版的依赖要求。[目录查询](../projects/plugin-market/src/catalog/queries.ts) · [归档检查](../projects/plugin-market/src/registry/tarball.ts)

**Metadata only** 的包可以浏览。**Versions** 按页提供已检查的发行、包内 README、摘要和发布证明。仓库所有者来自包声明的 GitHub 地址，星数带有独立的观测时间；官方标记由市场管理。发布证明以该次发行的校验记录为准。[HTTP 契约](../projects/plugin-market/README.md#http-契约) · [Provenance 边界](../projects/plugin-market/README.md#provenance-边界)

## 同一查看器里的不同来源

| 从哪里打开                   | README 与版本                                                           | 点依赖时                                                                       |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 市场概览或发行               | 概览用 registry README，展开某次发行可读该归档内的 README               | 优先打开相同市场和 registry 的详情，标明上级声明的范围；未收录时可搜索其他来源 |
| Installed 中的受管包或应用包 | 从当前发布记录的目录或应用工作目录解析实际安装的副本，读取清单和 README | 从上一级包的实际目录解析其声明的依赖，保留 pnpm 嵌套副本的版本                 |
| 显式查询公共 npm             | 浏览器匿名读取包级 README 和所选版本清单                                | 根据上级声明的范围选择公共 npm 上匹配的版本，仅供阅读                          |

独立网页与 Workbench 共用目录、吸顶标题、版本导航、依赖列表和 Markdown 渲染器。宽屏侧栏停靠在标题下方，可在阅读时查看资料或跳转章节；窄屏将资料收起，留出正文空间。返回会恢复来源页的选择和键盘焦点。已安装列表中的包名进入查看器，插件节点名则将完整节点地址交给 Shell，打开对应实例的运行详情。[查看器](../plugins/package-manager/src/ui/package-viewer.tsx) · [节点导航](../docs/workbench/view.md)

公共 React 入口可独立挂载。Workbench 通过 `MarketplaceData` 接入每个文档自己的查询资源，在同一组件中添加安装选择和本机状态。主题统一定义正文、次要文本、强调色、控件边界和焦点等角色；Workbench 采用 Mantine 主题，独立网页使用同色阶的明暗默认值。主题回归在画布、面板和提示底色上检查文字对比度至少为 4.5∶1，交互控件边界至少为 3∶1。README 中的 HTML 作为文本显示，代码高亮按语言加载。[主题](../plugins/package-manager/src/ui/package-theme.ts) · [对比度回归](../plugins/package-manager/tests/package-theme.test.ts)

## 两条安装路径

**从市场安装。** 用户为每个包选择来源和精确版本。包管理器读取已检查发行的 `pluxel.pluginPackages` 和 peer 范围，为必需插件寻找同时满足所有上级的版本，优先较新的已检查版本，冲突时回溯。显式选择固定版本；已有受管依赖优先沿用其已安装版本，变更来源或替换不兼容版本需要显式选择。可选插件由用户决定是否加入。隐式依赖沿用上级的市场和 registry；多个上级要求不同来源时，预览返回冲突及包名。一张图最多容纳 100 个受管包，预览列出新增依赖及其上级。[依赖解析](../plugins/package-manager/src/market-dependencies.ts)

**从应用 registry 查找。** **Find plugins** 支持关键词和精确包名、版本或标签。关键词用于发现候选；pnpm resolver 读取所选版本的清单，检查其 `@pluxel/core` peer 是否兼容当前宿主、包根能否导出 JavaScript。预览和程序化安装都会复核本次请求包的实际文件；包若声明 `pluxel.control`，控制清单还须包含这个包的根插件定义。普通传递依赖由 pnpm 解析。未声明控制清单的包只能得到基础兼容性检查，实际加载结果以 Host 报告为准。[Registry 搜索与检查](../plugins/package-manager/src/registry-discovery.ts)

两条交互路径均生成一份固定版本的安装预览。市场安装额外核对 pnpm 选择的 registry、精确版本与市场记录的 SHA-512。确认时发布已审阅的文件；发布失败按包返回实际结果。Workbench 依据受管版本和已核验的 registry 显示安装状态与更新提示，来源未知的同名包单独标明。安装回执可进入管理页，单包或批量卸载都先审阅包名、版本及宿主使用情况，再按已审阅的 revision 撤回入口。[安装记录与恢复](../plugins/package-manager/DESIGN.md)

## 验证入口

- 来源隔离、镜像归档校验、元数据与已检查发行的区分见[市场服务回归](../projects/plugin-market/tests/worker.test.ts)。
- 市场依赖图、来源冲突、安装预览和部分失败回执见[安装回归](../plugins/package-manager/tests/store.test.ts)。未收录包的准入和嵌套安装的实际解析分别见[Registry 回归](../plugins/package-manager/tests/registry-discovery.test.ts)和[本地包回归](../plugins/package-manager/tests/local-package.test.ts)。
- 独立目录中的版本切换、依赖跳转和返回焦点见[市场 UI 回归](../plugins/package-manager/tests/marketplace-ui.test.tsx)。受管包与应用包的操作和卸载审阅见[安装管理回归](../plugins/package-manager/tests/installed-packages.test.tsx)。
