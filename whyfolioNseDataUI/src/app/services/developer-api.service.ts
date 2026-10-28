import { inject, Injectable } from '@angular/core';
import { ApiService } from './api.service';

export interface DeveloperProfile {
  id: string;
  email: string;
  name: string;
  organization: string;
  createdAt: string;
}

export interface DeveloperSession {
  token: string;
  expiresIn: number;
  user: DeveloperProfile;
}

export interface ApiEndpoint {
  id: string;
  method: string;
  path: string;
  label: string;
}

export interface DeveloperApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey extends DeveloperApiKey {
  secret: string;
}

export interface UsageRow {
  date: string;
  endpointId: string;
  requests: number;
  successes: number;
  clientErrors: number;
  serverErrors: number;
}

export interface TestRequest {
  endpointId: string;
  method: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body?: Record<string, unknown>;
  apiKey: string;
}

export interface TestResponse {
  statusCode: number;
  data: unknown;
}

export interface NseIngestionJob {
  jobId: string;
  trigger: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  requestedBy: string | null;
  expectedTradeDate: string | null;
  startedAt: string;
  completedAt: string | null;
  result: {
    skipped: boolean;
    skipReason: string | null;
    tradeDate: string | null;
    datasetVersion: string | null;
    reportCount: number | null;
    archiveDirectory: string | null;
    enrichment: {
      status: string;
      matchedFiles: number;
      fileCount: number;
      matchedRows: number;
      unmatchedRows: number;
    } | null;
    sourceRows: Record<string, number> | null;
  } | null;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class DeveloperApiService {
  private readonly api = inject(ApiService);

  getGoogleAuthConfig(): Promise<{ clientId: string }> {
    return this.api.request('GET', '/api/v1/developer/auth-config', undefined, false);
  }

  authenticateWithGoogle(body: { code: string; organization?: string }): Promise<DeveloperSession> {
    return this.api.request('POST', '/api/v1/developer/google', body, false);
  }

  getProfile(): Promise<DeveloperProfile> {
    return this.api.request('GET', '/api/v1/developer/profile');
  }

  updateProfile(
    changes: Pick<DeveloperProfile, 'name' | 'organization'>,
  ): Promise<DeveloperProfile> {
    return this.api.request('PATCH', '/api/v1/developer/profile', changes);
  }

  getApiKeys(): Promise<DeveloperApiKey[]> {
    return this.api.request('GET', '/api/v1/developer/api-keys');
  }

  createApiKey(name: string, scopes: string[]): Promise<CreatedApiKey> {
    return this.api.request('POST', '/api/v1/developer/api-keys', { name, scopes });
  }

  revokeApiKey(keyId: string): Promise<{ id: string; revoked: boolean }> {
    return this.api.request('DELETE', `/api/v1/developer/api-keys/${keyId}`);
  }

  updateApiKeyScopes(keyId: string, scopes: string[]): Promise<{ id: string; scopes: string[] }> {
    return this.api.request('PATCH', `/api/v1/developer/api-keys/${keyId}/scopes`, { scopes });
  }

  getEndpoints(): Promise<ApiEndpoint[]> {
    return this.api.request('GET', '/api/v1/developer/endpoints');
  }

  getUsage(days = 30): Promise<UsageRow[]> {
    return this.api.request('GET', `/api/v1/developer/usage?days=${days}`);
  }

  tryEndpoint(body: TestRequest): Promise<TestResponse> {
    return this.api.request('POST', '/api/v1/developer/try', body);
  }

  getNseIngestionStatus(): Promise<NseIngestionJob | null> {
    return this.api.request('GET', '/api/v1/developer/nse/ingestion');
  }

  startNseIngestion(options?: {
    tradeDate?: string;
    force?: boolean;
  }): Promise<{ accepted: boolean; job: NseIngestionJob | null }> {
    return this.api.request('POST', '/api/v1/developer/nse/ingestion', options ?? {});
  }
}
