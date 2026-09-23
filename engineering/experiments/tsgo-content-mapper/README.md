# TypeScript Content Mapper 实验

**普通 `.ts` / `.tsx` 无法通过官方 Content Mapper 拦截并补写类型。** 已安装的 TypeScript 7.0.2 尚不支持该功能；固定测试的官方 7.1 nightly 支持新扩展名，但明确拒绝内建扩展名。本目录是隔离实验，不修改 Pluxel 生产 API，也不要求插件改用 `.pluxel`。

## 复现

在仓库根目录运行；只在临时目录安装编译器，不修改 workspace manifest 或 lockfile：

```sh
mapper_toolchain=$(mktemp -d)
npm install --prefix "$mapper_toolchain" --no-audit --no-fund --ignore-scripts typescript@7.1.0-dev.20260922.1
node engineering/experiments/tsgo-content-mapper/run.mjs "$mapper_toolchain/node_modules/typescript/bin/tsc"
```

需要 Node.js 和仓库已安装的 TypeScript 7.0.2。脚本每次只清理本目录的 `.artifacts/`，生成测试工程、mapper 包链接和报告；失败时断言报错。完整输出同时写入 `.artifacts/report.json`。已记录结果见 [recorded-results.json](./recorded-results.json)，其中绝对目录已替换为 `<experiment>`。

验证时间：2026-09-23，Linux x64。精确版本：

| 项目                | 版本 / commit                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- |
| 仓库编译器          | `typescript@7.0.2`，`gitHead: 2bd066d87f5bafd315be9f40889d0a60b9e58e0b`                |
| 官方 nightly 编译器 | `typescript@7.1.0-dev.20260922.1`，`gitHead: 5f6db9c9148635b4cbf72f1193b821b9c6b42dcc` |
| Node.js             | `v24.16.0`                                                                             |
| 阅读的官方 main     | `c50e40d2ec0cd411ed6d8aa62e4ef5a187f34e65`                                             |

`tsgo` 是 native preview 阶段的命令名，7.0 RC 起官方命令名为 `tsc`；本实验使用官方 native 编译器，没有 fork 或补丁。

## 实测结果

| 验证                                  | 结果                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| 7.0.2：配置不存在的 mapper 包 + `.ts` | 退出 0，顶层 `contentMappers` 被忽略，不能据此认为插件加载成功                       |
| 7.0.2：传入 `--runExternalCode`       | `TS5023: Unknown compiler option '--runExternalCode'.`                               |
| 7.1：注册 `.ts` / `.tsx`              | 两者均报 `TS100021`，内建扩展名不可注册                                              |
| 7.1：自定义 `.pluxel`，未允许外部代码 | `TS100024`，要求 CLI `--runExternalCode`                                             |
| 7.1：自定义 `.pluxel` + mapper        | CLI 校验通过，绑定未知字段 `typo` 报 `TS2353`                                        |
| 官方 LSP                              | `--lsp --stdio`；初始化 `runExternalCode: true`；hover、属性补全和修改后的诊断均通过 |
| `.d.ts` emit                          | 生成 `plugin.d.pluxel.ts` 和 `host.d.ts`，保留投影依赖的非 export Schema             |
| 独立声明 consumer                     | 仅复制生成文件，不加载 mapper，`skipLibCheck: false`；7.0.2 和 7.1 都通过            |
| 声明 consumer 错误输入                | `retries: 3` 报 `TS2322`，证明保留 input `string`，没有退化为 any 或 output `number` |
| JavaScript emit                       | 只发射普通 `host.js`；**不发射映射源的 JS**，运行时仍需构建工具处理自定义扩展名      |

精确拒绝信息：

```text
error TS100021: Content mapper file extension '.ts' is a built-in extension and cannot be registered by a content mapper.
error TS100021: Content mapper file extension '.tsx' is a built-in extension and cannot be registered by a content mapper.
```

## 实验如何推导

[plugin.pluxel](./fixtures/plugin.pluxel) 只有 `private config = this.configs.use(Schema)`，没有静态 schema 字段。Schema 是一个独立的最小类型替身，区分可选的 `input.retries: string` 与必填的 `output.retries: number`；本实验不假装已经集成真实 Pluxel/Valibot API。

[mapper.mjs](./mapper/mapper.mjs) 识别该固定 fixture 的 class 名和 `configs.use(Schema)`，将源码原样映射为虚拟 `.ts`，追加同模块类型声明：

```ts
export interface DemoPlugin {
	readonly __pluxelInputs: (typeof Schema)['input']
}
```

宿主从 `InstanceType<typeof DemoPlugin>` 提取输入，检查绑定字段。这里直接引用原 schema，而不从 private `config` 反推：声明发射会把 private 字段变为 `private config;`，它无法承担可发布的类型桥接。生成 interface 使非导出的 Schema 也被声明 emitter 保留。生产实现应使用专有 symbol 等受控桥接，不能将本实验字符串字段直接视作框架契约。

此 mapper 采用**固定 fixture 的正则识别**，不支持任意 TS 语法、多个插件、继承、别名、内联 schema、多个 use、Part composition 或 Vault 声明；它证明协议和类型投影能运行，不是可投入生产的源码转换器。没有执行插件，也没有生成 runtime schema 元数据。

## 官方协议与编辑器边界

mapper 包的 `package.json` 声明 `typescript.contentMapper.exec`，tsconfig 顶层 `contentMappers` 声明包名与扩展名。编译器通过 stdin/stdout 的 `Content-Length` JSON-RPC 调用 `initialize`、`openProject`、`transform`、`closeProject`。demo 协商 UTF-16 坐标，返回 `.ts` 文本及原样 span mapping；附加的 interface 没有伪造原始位置。

直接 LSP 客户端是已运行的验证。VS Code 扩展激活、用户 UI 补全显示和其它编辑器未实测。官方扩展源码提供 `registerContentMappers()` 和 `js/ts.contentMappers.enabled`，并将开关传入 LSP 的 `initializationOptions.runExternalCode`；这不会绕过编译器对内建扩展名的限制。传统 TypeScript JS language-service plugin 也不能据此视作 TS7 可用的 transformer。

官方参考（固定源码快照）：

- [tsconfig 内建扩展名拒绝与外部代码开关](https://github.com/microsoft/TypeScript/blob/c50e40d2ec0cd411ed6d8aa62e4ef5a187f34e65/tsc/internal/tsoptions/tsconfigparsing.go)
- [JSON-RPC 类型与方法](https://github.com/microsoft/TypeScript/blob/c50e40d2ec0cd411ed6d8aa62e4ef5a187f34e65/tsc/internal/contentmapper/hostimpl.go)
- [span mapping 编码](https://github.com/microsoft/TypeScript/blob/c50e40d2ec0cd411ed6d8aa62e4ef5a187f34e65/tsc/internal/spanmap/spanmap.go)
- [官方 VS Code 注册接口](https://github.com/microsoft/TypeScript/blob/c50e40d2ec0cd411ed6d8aa62e4ef5a187f34e65/packages/vscode-typescript/src/extension.ts)

保留普通 `.ts` 插件时，需要显式类型桥接，或独立的 typegen/watch/声明发射流程。Content Mapper 不能直接完成该产品要求；改扩展名还会带来运行时构建与编辑器接入成本。
