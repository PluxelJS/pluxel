---
title: 本地体验插件发布与市场管理
description: 用真实私有 PNPR 与公共 npm 体验发布、通知、收录、多来源搜索、市场分类及管理操作。
---

本页用于 Pluxel 源码仓库。先按[工作区工具链](./workspace-toolchain.md)安装依赖并激活 mise。PNPR、独立 workerd 与 D1 由 Pitchfork 管理；演示插件、数据库、缓存及本地凭据保存在 `projects/plugin-market/.local-market/`。

市场同时连接两个真实来源：公共 `https://registry.npmjs.org` 和本地私有 PNPR。发行的身份始终是 `registry + name + version`，不会把本地包改写成公共 npm 坐标。PNPR 固定为 `0.1.0-alpha.17`，原生 router 将 `@market-demo/*` 交给需要认证的 hosted registry，其他名称交给只读 npm upstream；上游缓存由 PNPR 维护。

## 启动并准备可编辑插件

在仓库根执行：

```sh
pitchfork start market
vp run @pluxel-internal/plugin-market#sandbox:prepare
cd projects/plugin-market/.local-market/plugin
. ./.market.env
vp exec pluxel build
vp exec pluxel publish --webhook --market-url "$PLUXEL_MARKET_URL"
```

Pitchfork 同时启动 `market-registry` 并传入实际端口。市场启动时注册或登录本地 PNPR 账号，保存读取 token 和独立通知 token；`sandbox:prepare` 将 npm 认证写入项目 `.npmrc`，将通知 token 和连接地址写入 `.market.env`，两个文件权限均为 `0600`。命令输出不包含 token。

演示包名是 `@market-demo/pluxel-plugin-hello`，初始版本 `0.1.0`，源码位于 `src/hello.ts`。构建会执行标准 Plugin semantic lowering，生成真实 JavaScript、声明和包元数据。重复准备保留源码及版本，只更新生成的连接设置；端口变化后重新准备并重新加载 `.market.env`。

`MARKET_REGISTRY` 是无末尾 `/` 的 PNPR 来源坐标，`PLUXEL_MARKET_URL` 是市场地址，`PLUXEL_MARKET_TOKEN` 只授权通知提交和回执查询。CLI 只有在显式提供 `--market-url` 时才使用该 token。管理员凭据由下面的管理脚本直接读取本地会话，无需打印或手工复制。

CLI 分别打印 npm 发布结果、市场回执 JSON 和查询 URL。保存回执 `id`；`pending` 只表示已持久接收。`--webhook` 允许包已发布时再次通知同一坐标，保留窗口内会复用原回执；`--dry-run` 不发布也不提交通知。

## 通知列表、失败说明与手工收录

回到仓库根后，加载连接设置并执行：

```sh
. projects/plugin-market/.local-market/plugin/.market.env
vp run @pluxel-internal/plugin-market#sandbox:admin process
vp run @pluxel-internal/plugin-market#sandbox:admin notifications --registry "$MARKET_REGISTRY" '{"status":"failed","code":"provenance-runtime-unsupported","limit":20}'
vp run @pluxel-internal/plugin-market#sandbox:admin receipt <receipt-id>
vp run @pluxel-internal/plugin-market#sandbox:admin retry <receipt-id>
```

通知列表支持精确来源、包名、状态、失败 code 和游标分页。`receipt` 还返回内部诊断和 `retry` 决策，不返回租约等内部执行字段。成功查到失败回执时查询正常退出，任务结果由内容表达。

当前原生 workerd 的 provenance 验证尚未通过，处理后会得到 `failed` 与 `provenance-runtime-unsupported`。这种失败不能通过重试解决；`retry` 返回 `unavailable` 并以非零退出。通知 token 不能读取市场私有目录或执行管理操作。

演示包没有 attestations，可显式执行管理员刷新，校验真实私有制品后收录：

```sh
vp run @pluxel-internal/plugin-market#sandbox:admin refresh --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 0.1.0
vp run @pluxel-internal/plugin-market#sandbox:admin package --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello
```

`refresh` 在下载、摘要、包名/版本、公开文件和依赖检查通过并提交 D1 后才返回 `indexed`。原通知仍保留独立的失败结果。公共读取只查询市场数据库，不访问上游。匿名请求不会列出私有来源，私有包详情和私有回执返回 `404`；管理员可以查询这些记录。

## 搜索、来源、官方标记、分类和标签

包管理命令默认选择公共 npm；私有来源使用显式 `--registry`。目录列表和通知列表在不指定来源时查询管理员可读的全部来源。

```sh
vp run @pluxel-internal/plugin-market#sandbox:admin catalog '{"query":"cache","official":true}'
vp run @pluxel-internal/plugin-market#sandbox:admin catalog --registry "$MARKET_REGISTRY" '{"query":"hello"}'
vp run @pluxel-internal/plugin-market#sandbox:admin facets
```

搜索使用原生 FTS5，按包名、描述和市场标签中的词前缀匹配，多词同时满足；输入作为文本处理，不执行用户提供的 FTS 运算符。来源、`official`、`category` 和 `tag` 可以组合筛选。分页游标绑定查询，改变筛选时从第一页重新开始。`facets` 返回当前可读且可见包的分类和标签计数，匿名统计不包含私有记录。

官方标记、分类和标签由市场管理员维护，不根据 npm scope、包名、包内 keywords 或 repository 自动推断。演示包保持非官方，先设置分类与标签：

```sh
vp run @pluxel-internal/plugin-market#sandbox:admin metadata --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello '{"expectedRevision":1,"official":false,"category":"development","tags":["market-demo","private-registry"]}'
vp run @pluxel-internal/plugin-market#sandbox:admin catalog --registry "$MARKET_REGISTRY" '{"query":"private","category":"development","tag":"private-registry","official":false}'
```

category 可为 `null`，标签可为空数组。分类和标签使用小写 slug，例如 `storage`、`http-client`；最多 20 个不重复标签。上述操作提交 revision `2`。元数据编辑和隐藏/恢复共享同一个 revision，刷新 npm 观测不会覆盖它们。

公共 npm 操作省略 `--registry`。需要先浏览真实已发布包时，可以只观测目录元数据：

```sh
vp run @pluxel-internal/plugin-market#sandbox:admin observe @pluxel/wretch
vp run @pluxel-internal/plugin-market#sandbox:admin package @pluxel/wretch
```

`observe` 保存真实 registry 的描述、latest、README、license 和 repository，不下载 tarball、不创建发行、不改变通知结果。确认归属并读取当前 revision 后，再用 `metadata` 显式写入 `official: true`、分类与标签。这样旧版官方包或暂未通过制品检查的包也能被搜索查看，页面同时说明没有可安装发行。

需要收录发行时，先用 `npm view <package> version --registry https://registry.npmjs.org` 确认精确版本，再执行 `sandbox:admin refresh <package> <exact-version>`。旧 `@pluxel/runtime` peer 不代替当前 `@pluxel/core` peer；存在 attestations 的发行仍受 provenance gate 约束，不能降级成缺少证明。

发行详情保留包内 README 和 license；作者声明的 repository 与 provenance 验证分别表达各自事实。需要更新 GitHub stars 时，显式执行 `sandbox:admin repository <package>`，私源同样带 `--registry`。它只读取已观测的 repository 并缓存真实星标及观测时间；普通搜索和详情不会请求 GitHub。没有仓库或不支持的来源返回明确失败；请求失败保留上次结果，没有真实观测时为 `null`，页面不显示默认星标数。

## 独立浏览与官网挂载

打开市场服务输出的根地址，例如 `http://market.pluxel.localhost:8088/`，即可直接搜索和阅读公开插件。
独立页面使用与 Workbench 相同的 React 市场界面与公共 HTTP 协议，不依赖 Mantine、Workbench 或管理连接，也不提供安装按钮。
官网静态目录、子目录挂载与 API 地址选择见 [Worker README](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#独立网页与官网挂载)。

## 在 Workbench 浏览市场

启动现有 `plugin-host`，在 Package Manager 的配置中加入本地市场，例如：

```json
{
	"markets": [{ "id": "market-local", "url": "http://127.0.0.1:8787" }]
}
```

使用市场启动输出中的实际 URL；如需与其他设备共用，填写它们可访问的部署地址。通过运行中配置入口保存并检查应用结果，见[开发控制台](./dev-console.md#编辑配置)。市场地址由 Host 读取，管理员 token 不放进浏览器配置。

官方 plugin-host 将 **Marketplace** 作为用户可移除的初始侧栏入口，点击直接进入 `/market`。
其他应用可从“应用”目录固定它到侧栏，机制见[固定常用应用](../workbench/operations.md#固定常用应用)。
`/packages` 保留包管理与同一市场浏览入口。页面按可用宽度排列紧凑卡片，**Filters** 展开 Registry、官方标记、Category 和 Tag，与搜索组合使用；点击卡片的分类或标签即可筛选，Reset filters 恢复目录。默认匿名访问，因此当前只展示公开来源。

**View details** 先展示目录概览、README、license 和仓库；公共 npm 的精确版本可跳转 npmx。**Versions** 只列市场已检查的发行，选择后查看制品 README、依赖、integrity 和 provenance，再进入安装预览。只有目录观测、没有发行的包不能从这里开始安装。私有 PNPR 的查询和管理继续使用上述认证 CLI/API。

## 发布更新并观察 latest

在插件目录修改 `src/hello.ts`，再运行：

```sh
. ./.market.env
npm version 0.2.0 --no-git-tag-version --ignore-scripts
vp exec pluxel build
vp exec pluxel publish --webhook --market-url "$PLUXEL_MARKET_URL"
```

回到仓库根，刷新旧版可以先观测真实 dist-tag：

```sh
vp run @pluxel-internal/plugin-market#sandbox:admin refresh --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 0.1.0
vp run @pluxel-internal/plugin-market#sandbox:admin package --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello
vp run @pluxel-internal/plugin-market#sandbox:admin refresh --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 0.2.0
```

第一次刷新后 `distTags.latest` 已指向 `0.2.0`，但该版本尚未收录；直到最后一条刷新完成才有对应发行。来源内上游 latest 和市场已收录版本分别表达各自事实。

## 隐藏、冲突、恢复与审计

若已按上文编辑分类，当前 revision 为 `2`：

```sh
vp run @pluxel-internal/plugin-market#sandbox:admin hide --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 2
vp run @pluxel-internal/plugin-market#sandbox:admin show --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 2
vp run @pluxel-internal/plugin-market#sandbox:admin package --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello
vp run @pluxel-internal/plugin-market#sandbox:admin show --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 3
vp run @pluxel-internal/plugin-market#sandbox:admin audit --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello
```

隐藏提交 revision `3`；第二条故意使用旧 revision，返回 `conflict` 与实际 revision，并以非零退出。确认当前状态后恢复得到 revision `4`。失败冲突不生成成功审计，刷新不会解除隐藏或改变市场分类。若操作顺序不同，先查询当前 revision，不直接套用示例数字。

隐藏后目录、发行和统计均排除该包。认证响应使用 `no-store`；公共响应缓存最长 30 秒，隐藏不撤销已经下载的制品。市场 HTTP 查询使用 `registry` query 选择来源，包名和精确版本各编码为一个路径段，例如 `/v1/packages/%40market-demo%2Fpluxel-plugin-hello?registry=<encoded-registry>`。

管理脚本直接使用原生 Cap’n Web HTTP batch，每次调用创建并释放一个 session。显式设置 `MARKET_URL` 与 `MARKET_ADMIN_TOKEN` 可选择其他部署；`catalog` 和 `facets` 直接调用同一市场 HTTP 查询接口。

## 一次运行完整验收

在仓库根运行：

```sh
vp run @pluxel-internal/plugin-market#sandbox:verify
```

每次创建一个独立私有包，真实构建和发布两个版本，验证通知权限与去重、失败列表、provenance gate、私源制品摘要、版本观测、元数据编辑、FTS 搜索、分类标签统计、可见性冲突和审计。也检查匿名目录、统计和回执不泄露私有记录，通知 token 不能读取管理目录。产物保留在 `.local-market/runs/`，最近一次成功报告为 `.local-market/last-run.json`。

沙箱直接复用生产 Worker、原生网络请求和全部制品校验，不改写来源坐标或 tarball。首次空数据库会按文件顺序应用当前 SQL 迁移；已有数据库需要运营者显式迁移，不自动转换或清空。本地验收不证明真实 npm provenance、远程 D1、生产部署或 Host 安装已通过。

停止本次两个服务：

```sh
pitchfork stop market market-registry
```

停止后数据和 PNPR 缓存保留。修改独立沙箱脚本后重启相应服务；Pluxel Host 在线操作仍遵循[开发控制台](./dev-console.md)。HTTP、管理 API 与证明限制由 [Worker README](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md)维护。
