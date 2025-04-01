// GlobalContext.ts
// 定义全局上下文接口，包括 logger、config、eventBus（这里只是占位，不实现具体功能）

export interface Logger {
  info(message: string, ...optionalParams: any[]): void;
  error(message: string, ...optionalParams: any[]): void;
}

export interface Config {
  get(key: string): any;
}

export interface EventBus {
  // 此处留空或添加占位方法
}

export interface GlobalPluginContext {
  logger: Logger;
  config: Config;
  eventBus: EventBus;
  // 可以添加其他全局依赖
}
