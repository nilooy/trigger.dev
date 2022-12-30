export interface WebhookConfig {
  accessToken: string;
  callbackUrl: string;
  secret: string;
}

export interface NormalizedRequest {
  body: any;
  headers: Record<string, string>;
  searchParams: URLSearchParams;
}

export interface NormalizedResponse {
  body: any;
  headers: Record<string, string>;
  statusCode: number;
}

export interface HandleWebhookOptions {
  request: NormalizedRequest;
  secret?: string;
}

export interface ReceivedWebhook {
  id: string;
  event: string;
  payload: any;
  timestamp?: string;
  context?: any;
}

export type PerformRequestOptions = {
  accessToken: string;
  endpoint: string;
  params: any;
  cache?: CacheService;
};

export type DisplayProperties = {
  title: string;
  properties?: { key: string; value: string | number | boolean }[];
};

export interface PerformedRequestResponse {
  response: NormalizedResponse;
  isRetryable: boolean;
  ok: boolean;
}

export interface RequestIntegration {
  perform: (
    options: PerformRequestOptions
  ) => Promise<PerformedRequestResponse>;
  displayProperties: (endpoint: string, params: any) => DisplayProperties;
}

export interface WebhookIntegration {
  keyForSource: (source: unknown) => string;
  registerWebhook: (config: WebhookConfig, source: unknown) => Promise<any>;
  handleWebhookRequest: (
    options: HandleWebhookOptions
  ) =>
    | { status: "ok"; data: ReceivedWebhook }
    | { status: "ignored"; reason: string }
    | { status: "error"; error: string };
}

export interface CacheService {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
}
