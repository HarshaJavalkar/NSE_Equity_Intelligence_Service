import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { IconDirective } from '../../icon.directive';
import { DeveloperApiService, NseIngestionJob } from '../../services/developer-api.service';

@Component({
  selector: 'app-nse-ingestion',
  standalone: true,
  imports: [CommonModule, IconDirective],
  templateUrl: './nse-ingestion.component.html',
  styleUrl: './nse-ingestion.component.scss',
})
export class NseIngestionComponent implements OnInit, OnDestroy {
  private readonly developerApi = inject(DeveloperApiService);
  readonly job = signal<NseIngestionJob | null>(null);
  readonly loading = signal(false);
  readonly starting = signal(false);
  readonly message = signal('');
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  ngOnInit(): void {
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  async refresh(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      this.setJob(await this.developerApi.getNseIngestionStatus());
      this.message.set('');
    } catch (error) {
      this.message.set(this.errorText(error));
    } finally {
      this.loading.set(false);
    }
  }

  async startFetch(): Promise<void> {
    if (this.starting() || this.isRunning()) return;
    this.starting.set(true);
    this.message.set('');
    try {
      const result = await this.developerApi.startNseIngestion({ force: true });
      this.setJob(result.job);
      this.message.set(
        result.accepted ? 'NSE report fetch started.' : 'An NSE ingestion is already running.',
      );
    } catch (error) {
      this.message.set(this.errorText(error));
      await this.refresh();
    } finally {
      this.starting.set(false);
    }
  }

  isRunning(): boolean {
    return this.job()?.status === 'RUNNING';
  }

  private setJob(job: NseIngestionJob | null): void {
    this.job.set(job);
    if (job?.status === 'RUNNING') this.startPolling();
    else this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), 3000);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      this.setJob(await this.developerApi.getNseIngestionStatus());
    } catch (error) {
      this.message.set(this.errorText(error));
      this.stopPolling();
    } finally {
      this.pollInFlight = false;
    }
  }

  private errorText(error: unknown): string {
    const candidate = error as {
      error?: { error?: { message?: string } };
      message?: string;
    };
    return (
      candidate.error?.error?.message ??
      candidate.message ??
      'The NSE ingestion request could not be completed.'
    );
  }
}
