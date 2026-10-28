import { CommonModule } from '@angular/common';
import { Component, EventEmitter, inject, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconDirective } from '../../icon.directive';
import {
  ApiEndpoint,
  CreatedApiKey,
  DeveloperApiKey,
  DeveloperApiService,
} from '../../services/developer-api.service';

@Component({
  selector: 'app-api-keys',
  standalone: true,
  imports: [CommonModule, FormsModule, IconDirective],
  templateUrl: './api-keys.component.html',
  styleUrl: './api-keys.component.scss',
})
export class ApiKeysComponent implements OnInit {
  private readonly developerApi = inject(DeveloperApiService);

  @Output() secretCreated = new EventEmitter<string>();
  @Output() error = new EventEmitter<string>();
  @Output() success = new EventEmitter<string>();

  readonly keys = signal<DeveloperApiKey[]>([]);
  readonly endpoints = signal<ApiEndpoint[]>([]);
  readonly selectedScopes = signal<string[]>([]);
  readonly editingKeyId = signal<string | null>(null);
  keyName = 'Production application';
  readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      const [keys, endpoints] = await Promise.all([
        this.developerApi.getApiKeys(),
        this.developerApi.getEndpoints(),
      ]);
      this.keys.set(keys);
      this.endpoints.set(endpoints);
    } catch (error) {
      this.error.emit(this.errorText(error));
    }
  }

  async createKey(): Promise<void> {
    this.busy.set(true);
    try {
      const created: CreatedApiKey = await this.developerApi.createApiKey(
        this.keyName,
        this.selectedScopes(),
      );
      const { secret, ...key } = created;
      this.keys.update((keys) => [key, ...keys]);
      this.selectedScopes.set([]);
      this.secretCreated.emit(secret);
      this.success.emit('API key created. Copy it now; the full secret is shown only once.');
    } catch (error) {
      this.error.emit(this.errorText(error));
    } finally {
      this.busy.set(false);
    }
  }

  async revokeKey(key: DeveloperApiKey): Promise<void> {
    if (!window.confirm(`Revoke “${key.name}”? Requests using this key will stop working.`)) return;
    try {
      await this.developerApi.revokeApiKey(key.id);
      this.keys.update((keys) =>
        keys.map((item) =>
          item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item,
        ),
      );
      this.success.emit('API key revoked.');
    } catch (error) {
      this.error.emit(this.errorText(error));
    }
  }

  beginScopeEdit(key: DeveloperApiKey): void {
    this.editingKeyId.set(key.id);
    this.selectedScopes.set([...key.scopes]);
  }

  async saveScopes(key: DeveloperApiKey): Promise<void> {
    try {
      await this.developerApi.updateApiKeyScopes(key.id, this.selectedScopes());
      this.keys.update((keys) =>
        keys.map((item) =>
          item.id === key.id ? { ...item, scopes: [...this.selectedScopes()] } : item,
        ),
      );
      this.editingKeyId.set(null);
      this.success.emit('Endpoint access updated.');
    } catch (error) {
      this.error.emit(this.errorText(error));
    }
  }

  toggleScope(endpointId: string, checked: boolean): void {
    this.selectedScopes.update((scopes) =>
      checked
        ? [...new Set([...scopes, endpointId])]
        : scopes.filter((scope) => scope !== endpointId),
    );
  }

  setAllScopes(selected: boolean): void {
    this.selectedScopes.set(selected ? this.endpoints().map((endpoint) => endpoint.id) : []);
  }

  private errorText(error: unknown): string {
    const candidate = error as { error?: { error?: { message?: string } }; message?: string };
    return candidate.error?.error?.message ?? candidate.message ?? 'Could not update API keys.';
  }
}
