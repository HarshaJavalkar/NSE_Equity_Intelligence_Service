import { CommonModule } from '@angular/common';
import {
  afterNextRender,
  Component,
  inject,
  Injector,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconDirective } from './icon.directive';
import { ApiKeysComponent } from './components/api-keys/api-keys.component';
import { EndpointCatalogComponent } from './components/endpoint-catalog/endpoint-catalog.component';
import { NseIngestionComponent } from './components/nse-ingestion/nse-ingestion.component';
import { OverviewComponent } from './components/overview/overview.component';
import { ProfileComponent } from './components/profile/profile.component';
import { ApiService } from './services/api.service';
import { DeveloperApiService, DeveloperProfile } from './services/developer-api.service';

type PortalScreen = 'landing' | 'register' | 'login' | 'dashboard';
type DashboardTab = 'overview' | 'keys' | 'endpoints' | 'profile' | 'ingestion';

interface GoogleCodeResponse {
  code?: string;
  state?: string;
  error?: string;
}

interface GoogleCodeClient {
  requestCode(): void;
}

interface GoogleOAuthApi {
  initCodeClient(config: {
    client_id: string;
    scope: string;
    ux_mode: 'popup';
    select_account: boolean;
    state: string;
    include_granted_scopes: boolean;
    callback: (response: GoogleCodeResponse) => void;
    error_callback: (error: { type: string }) => void;
  }): GoogleCodeClient;
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleOAuthApi } };
  }
}

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    IconDirective,
    OverviewComponent,
    ApiKeysComponent,
    EndpointCatalogComponent,
    NseIngestionComponent,
    ProfileComponent,
  ],
  templateUrl: './portal.html',
  styleUrl: './app.scss',
  encapsulation: ViewEncapsulation.None,
})
export class App {
  private readonly api = inject(ApiService);
  private readonly developerApi = inject(DeveloperApiService);
  private readonly injector = inject(Injector);
  readonly screen = signal<PortalScreen>('landing');
  readonly activeTab = signal<DashboardTab>('overview');
  readonly busy = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly profile = signal<DeveloperProfile | null>(null);
  readonly canManageIngestion = signal(false);
  readonly oneTimeSecret = signal('');
  readonly copied = signal(false);
  readonly authForm = { organization: '' };
  private googleCodeClient: GoogleCodeClient | null = null;
  private googleState = '';

  constructor() {
    if (this.api.getSessionToken()) {
      this.screen.set('dashboard');
      void this.loadDashboard();
    }
  }

  navigate(screen: PortalScreen): void {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.screen.set(screen);
    if (screen === 'register' || screen === 'login') {
      afterNextRender(() => void this.mountGoogleButton(), { injector: this.injector });
    }
  }

  requestGoogleAuthorization(): void {
    if (!this.googleCodeClient) {
      this.errorMessage.set('Google sign-in is not ready. Reload this page and try again.');
      return;
    }
    this.googleCodeClient.requestCode();
  }

  async handleGoogleAuthorization(response: GoogleCodeResponse): Promise<void> {
    if (response.error || !response.code || response.state !== this.googleState) {
      this.errorMessage.set(
        'Google authorization was cancelled or could not be verified. Try again.',
      );
      return;
    }

    this.busy.set(true);
    this.errorMessage.set('');
    try {
      const isRegistration = this.screen() === 'register';
      if (isRegistration && this.authForm.organization.trim().length < 2) {
        throw new Error('Enter your organization before continuing with Google.');
      }
      const body = {
        code: response.code,
        ...(isRegistration ? { organization: this.authForm.organization } : {}),
      };
      const session = await this.developerApi.authenticateWithGoogle(body);
      this.api.setSessionToken(session.token);
      this.profile.set(session.user);
      this.screen.set('dashboard');
      await this.loadDashboard();
    } catch (error) {
      this.errorMessage.set(this.errorText(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async mountGoogleButton(): Promise<void> {
    if (!document.querySelector('.google-signin-button')) return;

    try {
      const [{ clientId }] = await Promise.all([
        this.developerApi.getGoogleAuthConfig(),
        this.ensureGoogleScript(),
      ]);
      if (!window.google?.accounts.oauth2) {
        throw new Error('Google Identity Services did not load.');
      }

      this.googleState = crypto.randomUUID();
      this.googleCodeClient = window.google.accounts.oauth2.initCodeClient({
        client_id: clientId,
        scope: 'openid email profile',
        ux_mode: 'popup',
        select_account: true,
        state: this.googleState,
        include_granted_scopes: true,
        callback: (response) => void this.handleGoogleAuthorization(response),
        error_callback: () =>
          this.errorMessage.set('Google authorization was cancelled or failed.'),
      });
    } catch (error) {
      this.errorMessage.set(this.errorText(error));
    }
  }

  private ensureGoogleScript(): Promise<void> {
    if (window.google?.accounts.oauth2) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const existing = document.getElementById(
        'google-identity-services',
      ) as HTMLScriptElement | null;
      const script = existing ?? document.createElement('script');
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Could not load Google sign-in.')), {
        once: true,
      });
      if (!existing) {
        script.id = 'google-identity-services';
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    });
  }

  async loadDashboard(): Promise<void> {
    try {
      this.profile.set(await this.developerApi.getProfile());
      try {
        await this.developerApi.getNseIngestionStatus();
        this.canManageIngestion.set(true);
      } catch {
        this.canManageIngestion.set(false);
      }
    } catch (error) {
      this.errorMessage.set(this.errorText(error));
      if (this.errorText(error).includes('session')) this.logout();
    }
  }

  async copySecret(): Promise<void> {
    await navigator.clipboard.writeText(this.oneTimeSecret());
    this.copied.set(true);
    window.setTimeout(() => this.copied.set(false), 1800);
  }

  closeSecret(): void {
    this.oneTimeSecret.set('');
  }

  logout(): void {
    this.api.clearSession();
    this.profile.set(null);
    this.canManageIngestion.set(false);
    this.screen.set('landing');
    this.activeTab.set('overview');
  }

  onProfileUpdated(profile: DeveloperProfile): void {
    this.profile.set(profile);
  }

  onError(message: string): void {
    this.errorMessage.set(message);
    this.successMessage.set('');
  }

  onSuccess(message: string): void {
    this.successMessage.set(message);
    this.errorMessage.set('');
  }

  onSecretCreated(secret: string): void {
    this.oneTimeSecret.set(secret);
  }

  private errorText(error: unknown): string {
    const candidate = error as { error?: { error?: { message?: string } }; message?: string };
    return (
      candidate.error?.error?.message ?? candidate.message ?? 'The request could not be completed.'
    );
  }
}
