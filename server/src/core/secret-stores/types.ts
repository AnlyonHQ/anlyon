export interface StoreClientContext {
  cacheKey: string;
  storeId: string;
  privateNetwork: boolean;
}

export interface ExternalLocation {
  path: string;
  key: string | null;
  version: string | null;
}
