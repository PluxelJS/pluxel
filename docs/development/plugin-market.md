---
title: 本地体验插件发布与市场管理
description: 用真实私有 PNPR 与公共 npm 体验发布、通知、收录、多来源搜索、市场分类及管理操作。
---

在 Pluxel 框架仓库内，可以通过本地启动的 PNPR 私有包仓库与插件市场后端（基于 Cloudflare Workers/D1 架构的本地模拟运行环境），完整体验插件构建、发包通知、制品索引校验、分类打标以及在 Workbench 控制台浏览的全流程。

## 启动本地市场与测试注册表

在仓库根目录下执行：

```sh
# 启动市场后端与私有 npm registry 服务
pitchfork start market

# 初始化本地演示插件与沙箱环境
vp run @pluxel-internal/plugin-market#sandbox:prepare

# 进入演示插件目录
cd projects/plugin-market/.local-market/plugin
. ./.market.env

# 构建并向本地私有市场发布插件
vp exec pluxel build
vp exec pluxel publish --webhook --market-url "$PLUXEL_MARKET_URL"
```

- 该流程将演示插件 `@market-demo/pluxel-plugin-hello` 发布到本地私有 PNPR 注册表中，并通过 Webhook 向本地市场端点提交发布通知。
- 控制台将输出发布回执 ID（Receipt ID），用于后续查询索引进度。

## 管理员手工审核与制品收录

在本地沙箱中，可通过管理员命令行工具查看收录通知、手动触发版本索引校验并设置分类标签：

```sh
# 加载环境变量
. projects/plugin-market/.local-market/plugin/.market.env

# 触发管理员审核并收录指定版本
vp run @pluxel-internal/plugin-market#sandbox:admin refresh --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 0.1.0

# 为插件配置分类与搜索标签
vp run @pluxel-internal/plugin-market#sandbox:admin metadata --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello '{"expectedRevision":1,"official":false,"category":"development","tags":["market-demo","private-registry"]}'

# 查看插件收录元数据
vp run @pluxel-internal/plugin-market#sandbox:admin package --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello
```

## 搜索与多维度筛选

市场服务内置了基于 SQLite FTS5 的全文检索能力，支持按包名、描述关键词以及打标分类进行多维度查询：

```sh
# 搜索特定关键字与官方标记
vp run @pluxel-internal/plugin-market#sandbox:admin catalog '{"query":"cache","official":true}'

# 按特定私有源筛选
vp run @pluxel-internal/plugin-market#sandbox:admin catalog --registry "$MARKET_REGISTRY" '{"query":"hello"}'

# 查询当前的分类与标签统计快照
vp run @pluxel-internal/plugin-market#sandbox:admin facets
```

## 在控制台（Workbench）中浏览插件市场

在宿主应用的 `PackageManagerPlugin` 配置中填入本地市场地址：

```json
{
	"markets": [{ "id": "market-local", "url": "http://127.0.0.1:8787" }]
}
```

启动宿主应用后，在 Workbench 侧边栏点击 **Marketplace**（或访问 `/market` 路由），即可在图形化界面中查看已收录的插件列表、版本发布历史与 README 文档。

## 运行端到端沙箱自动化验收

在仓库根目录下运行全套沙箱回归测试：

```sh
vp run @pluxel-internal/plugin-market#sandbox:verify
```

该命令会自动创建临时私有包，执行版本发布、Webhook 去重、制品元数据抽取、全量 FTS 索引与包可见性切换等一整套自动化流程。测试完成后，可通过以下命令停止本地服务：

```sh
pitchfork stop market market-registry
```
