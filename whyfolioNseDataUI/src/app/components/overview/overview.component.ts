import { CommonModule } from '@angular/common';
import { Component, EventEmitter, inject, Input, OnInit, Output, signal } from '@angular/core';
import { IconDirective } from '../../icon.directive';
import {
  ApiEndpoint,
  DeveloperApiKey,
  DeveloperApiService,
  DeveloperProfile,
  UsageRow,
} from '../../services/developer-api.service';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [CommonModule, IconDirective],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
})
export class OverviewComponent implements OnInit {
  private readonly developerApi = inject(DeveloperApiService);
  @Input() profile: DeveloperProfile | null = null;
  readonly usage = signal<UsageRow[]>([]);
  readonly keys = signal<DeveloperApiKey[]>([]);
  readonly endpoints = signal<ApiEndpoint[]>([]);
  errorMessage = '';

  @Output() navigateTo = new EventEmitter<'keys' | 'endpoints'>();
  @Output() error = new EventEmitter<string>();

  async ngOnInit(): Promise<void> {
    try {
      const [usage, keys, endpoints] = await Promise.all([
        this.developerApi.getUsage(),
        this.developerApi.getApiKeys(),
        this.developerApi.getEndpoints(),
      ]);
      this.usage.set(usage);
      this.keys.set(keys);
      this.endpoints.set(endpoints);
    } catch (error) {
      this.error.emit(this.errorText(error));
    }
  }

  endpointTotal(): number {
    return this.usage().reduce((total, row) => total + row.requests, 0);
  }

  activeKeys(): number {
    return this.keys().filter((key) => !key.revokedAt).length;
  }

  endpointLabel(endpointId: string): string {
    return this.endpoints().find((endpoint) => endpoint.id === endpointId)?.label ?? endpointId;
  }

  private errorText(error: unknown): string {
    const candidate = error as { error?: { error?: { message?: string } }; message?: string };
    return (
      candidate.error?.error?.message ?? candidate.message ?? 'Could not load workspace activity.'
    );
  }
}
