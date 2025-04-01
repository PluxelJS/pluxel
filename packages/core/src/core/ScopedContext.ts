// ScopedContext.ts
// 定义每个插件专用的上下文，既包含全局依赖，也支持 disposable 注册和释放

import { GlobalPluginContext } from "./GlobalContext";

export interface Disposable {
  dispose(): void;
}

export interface ScopedPluginContext extends GlobalPluginContext {
  registerDisposable(disposable: Disposable): void;
  dispose(): void;
}

export function createScopedContext(
  globalCtx: GlobalPluginContext
): ScopedPluginContext {
  const disposables: Disposable[] = [];
  return {
    ...globalCtx,
    registerDisposable(disposable: Disposable) {
      disposables.push(disposable);
    },
    dispose() {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (err) {
          globalCtx.logger.error("Error disposing resource", err);
        }
      }
    },
  };
}
