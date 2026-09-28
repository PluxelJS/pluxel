# @pluxel/create

创建固定的 Pluxel 示例工作区，要求 Node.js 24+。

```sh
pnpm create @pluxel my-workspace
pnpm create @pluxel my-workspace --no-install
```

目标目录必须不存在或为空。初始化器验证模板只含普通文件、不含符号链接，在相邻临时目录完成复制后 rename 到目标；将模板中的 `gitignore` 映射为 `.gitignore`，其余已发布资产按原内容复制。

## 生成的工作区

模板是 `@example/*` monorepo：独立 `host/web` 包、一份宿主 Vite 配置、一份支持可选动态来源的应用声明、同源 Todo API、测试与构建治理。根目录固定安装 Portless，`pnpm dev` 使用稳定的 `https://<directory>.localhost`；应用与 Workbench 是同一个 Vite listener 上的不同路径。`dev:direct` 或 `PORTLESS=0` 显式跳过 Portless。

生成项目链接上游权威文档，不复制易过期的文档快照。根目录通过 `pncat` 维护 catalog 版本策略；各包仍声明自己的直接 runtime、peer 和 dev dependencies。治理检查拒绝裸第三方版本，本地包之间保留各包拥有的 workspace / peer 契约。

## 包与构建边界

本包无 runtime dependencies，也不加载 `@pluxel/cli`。后者只是生成工作区的开发依赖，为用户提供 `pluxel new` 与构建命令。

`tsdown.config.ts` 生成带 shebang 的 `create-pluxel` Node 24 ESM 单文件入口，并复制固定 `template/` 到 `dist/template/`。构建完成时根据当前可发布包 manifest 更新发布模板的 Pluxel catalog；源码模板不是发布版本的另一套权威。文件位置见[实现索引](IMPLEMENTATION_INDEX.md)。

## 验证

```sh
pnpm --filter @pluxel/create test
pnpm --filter @pluxel/create test:starter
```

第一项验证创建行为、工作区治理与文档链接。第二项打包后在仓库外安装生成项目，执行 `pnpm verify`，启动生产发行物，并验证统一 Vite 应用集成。
