/** Subset of the FDK v9 front-end client (`app.initialized()`). */
export interface FdkClient {
  data: { get(name: string): Promise<Record<string, any>> };
  iparams: { get(name?: string): Promise<Record<string, any>> };
  request: {
    invoke(fn: string, args: Record<string, unknown>): Promise<{ response: any }>;
    invokeTemplate(name: string, opts: { context?: Record<string, unknown>; body?: string }): Promise<{ status: number; response: string; headers?: Record<string, string> }>;
  };
  interface: { trigger(action: string, opts: Record<string, unknown>): Promise<unknown> };
  events: { on(event: string, cb: (event: any) => void, opts?: { intercept?: boolean }): void };
  instance?: { resize(opts: { height: string }): void };
  db?: { get(key: string): Promise<any>; set(key: string, value: unknown): Promise<unknown> };
}

declare global {
  // Injected by the FDK runtime (https://static.freshdev.io/fdk/2.0/assets/fresh_client.js)
  // eslint-disable-next-line no-var
  var app: { initialized(): Promise<FdkClient> } | undefined;
}
