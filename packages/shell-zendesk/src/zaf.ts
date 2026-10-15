/** The subset of the ZAF v2 client used by the app (window.ZAFClient.init()). */
export interface ZafRequestOptions {
  url: string;
  type?: string;
  contentType?: string;
  data?: string;
  headers?: Record<string, string>;
  secure?: boolean;
  cors?: boolean;
  httpCompleteResponse?: boolean;
  jwt?: { algorithm: 'HS256'; secret_key: string; expiry?: number; claims?: Record<string, unknown> };
}

export interface ZafCompleteResponse {
  status: number;
  responseJSON?: unknown;
  responseText?: string;
  headers?: Record<string, string>;
}

export interface ZafClient {
  get(paths: string | string[]): Promise<Record<string, unknown>>;
  set(path: string, value: unknown): Promise<unknown>;
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  off(event: string, handler: (...args: unknown[]) => unknown): void;
  request<T = unknown>(opts: ZafRequestOptions | string): Promise<T>;
  metadata(): Promise<{ appId: number; installationId: number; settings: Record<string, string | undefined>; version?: string }>;
  context(): Promise<{ location: string; account: { subdomain: string }; ticketId?: number }>;
}

declare global {
  interface Window {
    ZAFClient?: { init(): ZafClient };
  }
}
