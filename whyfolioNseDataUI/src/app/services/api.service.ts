import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly sessionKey = 'developerSession';

  async request<T>(method: string, url: string, body?: unknown, authenticated = true): Promise<T> {
    const token = authenticated ? this.getSessionToken() : null;
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;
    const response = await firstValueFrom(
      this.http.request<ApiEnvelope<T>>(method, url, { body, headers }),
    );
    return response.data;
  }

  getSessionToken(): string | null {
    try {
      return sessionStorage.getItem(this.sessionKey);
    } catch {
      return null;
    }
  }

  setSessionToken(token: string): void {
    sessionStorage.setItem(this.sessionKey, token);
  }

  clearSession(): void {
    try {
      sessionStorage.removeItem(this.sessionKey);
    } catch {
      return;
    }
  }
}
