import { CommonModule } from '@angular/common';
import { Component, EventEmitter, inject, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconDirective } from '../../icon.directive';
import {
  ApiEndpoint,
  DeveloperApiService,
  TestResponse,
} from '../../services/developer-api.service';

interface PlaygroundResponse {
  status: number;
  body: string;
}

@Component({
  selector: 'app-endpoint-catalog',
  standalone: true,
  imports: [CommonModule, FormsModule, IconDirective],
  templateUrl: './endpoint-catalog.component.html',
  styleUrl: './endpoint-catalog.component.scss',
})
export class EndpointCatalogComponent implements OnInit {
  private readonly developerApi = inject(DeveloperApiService);

  @Output() error = new EventEmitter<string>();
  @Output() success = new EventEmitter<string>();

  readonly endpoints = signal<ApiEndpoint[]>([]);
  apiBaseUrl = 'http://localhost:3000';
  playgroundEndpointId = 'market.equity.read';
  playgroundSymbol = 'IREDA';
  playgroundIsin = '';
  playgroundQuery = 'IREDA';
  playgroundSections = 'market,results';
  playgroundBatchSymbols = 'IREDA,XYZ';
  testApiKey = '';
  readonly busy = signal(false);
  readonly requestCopied = signal(false);
  readonly playgroundResponse = signal<PlaygroundResponse | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.endpoints.set(await this.developerApi.getEndpoints());
    } catch (error) {
      this.error.emit(this.errorText(error));
    }
  }

  selectedEndpoint(): ApiEndpoint | undefined {
    return this.endpoints().find((endpoint) => endpoint.id === this.playgroundEndpointId);
  }

  endpointRequest(): { method: string; url: string; body?: unknown } {
    const endpoint = this.selectedEndpoint();
    if (!endpoint) return { method: 'GET', url: this.apiBaseUrl.trim() };

    let path = endpoint.path.replace(
      ':symbol',
      encodeURIComponent(this.playgroundSymbol.trim() || 'SYMBOL'),
    );
    path = path.replace(':isin', encodeURIComponent(this.playgroundIsin.trim() || 'ISIN'));
    const query = new URLSearchParams();
    if (endpoint.id === 'market.search') query.set('q', this.playgroundQuery.trim() || 'SYMBOL');
    if (endpoint.id === 'market.equity.read' && this.playgroundSections.trim()) {
      query.set('sections', this.playgroundSections.trim());
    }

    const url = `${this.apiBaseUrl.trim().replace(/\/$/, '')}${path}${query.size ? `?${query}` : ''}`;
    if (endpoint.method !== 'POST') return { method: endpoint.method, url };

    return {
      method: endpoint.method,
      url,
      body: {
        symbols: this.playgroundBatchSymbols
          .split(',')
          .map((symbol) => symbol.trim())
          .filter(Boolean),
        sections: this.playgroundSections
          .split(',')
          .map((section) => section.trim())
          .filter(Boolean),
      },
    };
  }

  async sendTestRequest(): Promise<void> {
    const endpoint = this.selectedEndpoint();
    if (!endpoint) return;
    if (!this.testApiKey.trim()) {
      this.error.emit('Enter the endpoint-scoped API key.');
      return;
    }

    this.busy.set(true);
    this.playgroundResponse.set(null);
    const params: Record<string, string> = {};
    if (endpoint.path.includes(':symbol')) params['symbol'] = this.playgroundSymbol.trim();
    if (endpoint.path.includes(':isin')) params['isin'] = this.playgroundIsin.trim();

    const query: Record<string, string> = {};
    if (endpoint.id === 'market.search') query['q'] = this.playgroundQuery.trim();
    if (endpoint.id === 'market.equity.read' && this.playgroundSections.trim()) {
      query['sections'] = this.playgroundSections.trim();
    }

    let body: Record<string, unknown> | undefined;
    if (endpoint.id === 'market.equity.batch') {
      body = {
        symbols: this.playgroundBatchSymbols
          .split(',')
          .map((symbol) => symbol.trim())
          .filter(Boolean),
        sections: this.playgroundSections
          .split(',')
          .map((section) => section.trim())
          .filter(Boolean),
      };
    }

    try {
      const result: TestResponse = await this.developerApi.tryEndpoint({
        endpointId: endpoint.id,
        method: endpoint.method,
        params,
        query,
        body,
        apiKey: this.testApiKey,
      });
      this.playgroundResponse.set({
        status: result.statusCode,
        body: JSON.stringify(result.data, null, 2),
      });
    } catch (error) {
      const response = error as { status?: number; error?: unknown };
      this.playgroundResponse.set({
        status: response.status ?? 0,
        body: JSON.stringify(response.error ?? { message: this.errorText(error) }, null, 2),
      });
    } finally {
      this.busy.set(false);
    }
  }

  requestExample(): string {
    const request = this.endpointRequest();
    const lines = [
      `curl -X ${request.method} '${request.url}'`,
      `  -H 'Authorization: Bearer $WHYFOLIO_JWT'`,
      `  -H 'X-API-Key: $MARKET_API_KEY'`,
    ];
    if (request.body) {
      lines.push(`  -H 'Content-Type: application/json'`);
      lines.push(`  --data '${JSON.stringify(request.body)}'`);
    }
    return lines.join(' \\\n');
  }

  async copyRequestExample(): Promise<void> {
    await navigator.clipboard.writeText(this.requestExample());
    this.requestCopied.set(true);
    window.setTimeout(() => this.requestCopied.set(false), 1800);
  }

  async copyText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    this.success.emit('Endpoint copied.');
  }

  private errorText(error: unknown): string {
    const candidate = error as { error?: { error?: { message?: string } }; message?: string };
    return (
      candidate.error?.error?.message ?? candidate.message ?? 'Could not load the endpoint catalog.'
    );
  }
}
