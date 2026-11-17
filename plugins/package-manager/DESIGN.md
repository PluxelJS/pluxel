# Package Manager 插件设计

## 所有权与消费

`PackageManagerConfig` 是导出的部署 schema，与 Plugin 的 `configs.use()` 共用；Host config/env/file 优先级只拥有部署策略。
持久化安装清单和发布 revision 属于业务状态，不反向覆盖配置。公共 `snapshot/install/remove` 与 Commands 在无 Workbench 时完整可用；
Workbench target 仅投影同一 store，不是配置或安装操作的唯一入口。registry/auth/proxy 保留 pnpm 原生输入契约，不另建普通 secret 配置。

`/market` 和 `/packages` 两个 Direct View 通过同一 `PackageManagerApi` factory 绑定同一 Store，每个打开项独立拥有 RPC root 和 renderer query resources。资源定义由一个工厂按 descriptor 建立，不能跨 open 共享查询缓存。市场浏览的 `./marketplace` 导出仅依赖 React、无导入的 market DTO 和公共 HTTP client，不引入 Mantine、Workbench 或 CapnWeb；Workbench adapter 与公开 UI 不在同一导出依赖图。

市场 UI 的搜索、分页和所选坐标只有一个 React 所有者；`MarketplaceData` 的四个稳定读取组件只提供当前查询状态，通过 render children 投影结果。使用组件 slot 保持 React hook 静态调用，不能在 props 中动态传 hook。Workbench adapter 复用原有 per-open queryFamily；独立网页自行拥有 HTTP 请求、取消和晚到结果清理。`onPrepare` 是宿主显式授予的能力，缺省只浏览，不建立第二套安装或收藏服务。

Plugin 拥有 pnpm acquisition、配置、安装记录、单写者 lock、commands 和可选 Direct View。Host 只消费普通 ESM wrapper；不读取安装私有状态。init 在任何 native/文件/UI 副作用前用 requirePluginSource 校验 rootDir/entries，返回 next-start/live 事实。Native 下次新进程启动扫描；Vite 独立报告目录事务与 lifecycle。

## 不可变安装与发布

市场和直接安装由同一个 Plugin 拥有。`markets: []` 默认不进行目录请求；market client 只访问部署方配置的 base URL，页面只能提交连接 ID。公共 HTTP 的读取有 timeout、响应大小与 DTO 校验边界，禁止重定向；错误不退化为空目录，也不影响直接安装。Worker 是独立项目，不要求消费端启动 Pluxel Host 服务端。

交互安装先 `prepareInstall` / `prepareMarketInstall`，再 `confirmInstall`。准备使用相同 pnpm engine 完整物化私有 revision，保留 registry/auth/proxy 语义，不另建 npm resolver。每 store 只保留一个内存候选，10 分钟有效；候选 ID、selection revision、固定版本、SRI 和图/字节绑定。确认重新核对文件再提交，不执行第二次 acquisition。停止、替换候选或其他安装 mutation 使旧预览失效；候选不是跨进程持久任务。

市场包身份为 registry + name；官方标记、分类和标签消费市场自身的管理事实，不根据 scope 或 provenance 推断。列表筛选、renderer query key、版本选择、精确发行和安装准备保留同一 registry。公开查询省略来源时明确选择公共 npm；安装准备必须显式携带来源，不能从不可用私有包回退公共同名包。客户端不持有管理密钥，受保护来源由市场访问控制决定是否可读。

包概览与可安装发行是不同事实：`marketPackage` 允许只观察过元数据的包显示 registry README、许可和声明仓库，`indexedVersions: 0` 不产生安装入口。Workbench 先读概览，打开版本页才查询已校验发行；发行 README 来自已校验 archive。两处 README 复用 browser-safe mdast/GFM 到 React 的渲染器：不注入 HTML、不加载包声明的图片，只允许 HTTP(S)/mailto 绝对链接，相对链接保留文字，表格和代码块在局部横向滚动。来源 stars 仅消费带观测时间的实际缓存，声明仓库和官方标记不赋予 provenance verified 状态。

市场选择由后端读取精确发行，核对 pnpm registry、lockfile SRI 和实际 package.json name/version；市场 tarball URL 不进入 acquisition。pnpm 的 scoped registry 优先于 default，来源不一致在 acquisition 之前拒绝；相同来源复用原生认证和代理配置。确认后的顶层选择固定为精确版本，原请求范围保留在预览。准备允许显式策略授权的构建脚本，故不承诺只读。当前预览覆盖受管包图变化，不冒充完整 Host Plugin/fork 生命周期预检。

每次 mutation 将完整 manifest 交给一次 pnpm install，私有 revisions/<uuid> 保存 manifest/lockfile/node_modules 链接和 inner entries。global virtual store 位于 root/slots，copy 导入包字节；相同 resolution、peer context 和依赖图复用同一物理 slot，A/B 不会因安装批次得到两份共同 P。

pnpm v9 graph fingerprint 包含 resolution、peer、optional 和可达依赖；实际 slot 闭包字节再做摘要。图与字节未变时必须保留同一物理路径与旧 inner entry，改变了就拒绝。图变化的包使用新 inner entry。未知图不做保守全量重发，明确拒绝。

published-installation.json 是当前安装选择的唯一 authority；准备失败保持原记录。保存新记录后逐项原子交换公开 entries/<encoded-name>.mjs，撤回 stale wrapper。不是 batch atomic：IO 失败后按实际 wrapper 比对给出部分成功回执；snapshot 的 entryFile 只有与当前 authority 一致时存在；pendingRemovals 从 entries 中已离开选择的残留入口推导，UI 提供显式撤回重试，不另存恢复清单。下一 mutation 可以重试发布；显式 remove 也接受已从安装选择移除但仍残留公开 wrapper 的包，仅重试撤回时不重新执行 pnpm。混合新卸载与撤回重试按所有涉及条目的实际文件给出回执。initialize 不修复错误合同。

卸载只移除公开 wrapper。旧 revisions、slots、资源和制品一直保留到明确离线维护；close 撤回 mutation/publication 并等待已接纳 native install 真实结算，随后释放 writer。不存在启动迁移或自动 GC。

## 写者与恢复

原生引擎调用前校验首个非空 pnpm/npm workspace-dir 环境覆盖与显式 dir 一致；冲突直接拒绝，不允许调度环境把私有 revision 安装指向 Host 工作区，也不全局修改进程环境。原生集成测试在独立 worker 中清除调度覆盖，另用子进程与临时旁工作区回归四种拼写、空值与优先级、匹配目录及旁工作区字节不变。

目录内 mkdir .writer 原子获得跨进程单写者 ownership；EEXIST 返回 PACKAGE_STORE_WRITER_CONFLICT，其余 IO 错误保持原生错误。异常退出的遗留 lock 只能由操作者离线核对并删除。启动验证 index、物理 containment、inner entries、slot bytes 和公开 wrapper；旧布局与不一致内容明确失败，不静默迁移或重新发布。

## 能力与回执

package.install/remove commands、Plugin 方法和每次打开的 owner-bound Workbench target 复用同一 store。初始化、mutation 和 snapshot 共用串行队列，snapshot 不混合两次提交的事实；关闭同步撤销 admission，等待已开始初始化/安装和同一次 writer 释放，缓存句柄也不能继续读取。调用时捕获输入数组，排队期间调用方修改原数组不改变操作目标。关闭 Workbench 不影响安装。停止 Plugin 撤回 commands/View、abort target 和安装 admission；持久文件不因 generation cleanup 删除。

succeeded 表示 wrapper 已发布，failed 保留 INVALID_SPEC/INSTALL_FAILED/REMOVE_FAILED，绝不表示实际 Plugin 已运行。Vite catalog、native next-start 与 auto-start/session intent 是另外的事实。public snapshot 不返回 registry/auth/proxy/raw native event；native acquisition 错误使用经过挑选的领域消息。

默认忽略 scripts、空 allowBuilds 和 24 小时 minimum release age。放宽 scripts 必须同时显式配置非空 exact allow-list。只接纳 canonical registry package name 与版本/range/dist-tag；alias/path/URL/Git 属于其他 producer。

## 验证入口

store.test 验证发布失败/取消/未知图与未变条目；immutable-installation.test 使用真实 registry tarballs、pnpm global slots、原生 fresh process 和固定 PackageManagerPlugin 的生产 Vite，覆盖 A/B/P 身份、wrapper/运行代/Node 制品精度、普通 ESM 更新、HTTP/WebSocket、工厂失败恢复、跨进程写者与关闭。pnpm-engine 的 local registry 用原生新进程验证发布与消费分离；隔离 plugin tests 只证明业务边界。
