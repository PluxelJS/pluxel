// GlobalContext.ts
// 定义全局上下文接口，包括 logger、config、eventBus（这里只是占位，不实现具体功能）

export interface Logger {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  info(message: string, ...optionalParams: any[]): void;
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  error(message: string, ...optionalParams: any[]): void;
}

export interface Config {
  get(key: string): any;
}

export interface GlobalPluginContext {
  logger: Logger;
}
