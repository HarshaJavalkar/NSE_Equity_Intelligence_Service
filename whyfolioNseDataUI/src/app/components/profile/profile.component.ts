import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  Output,
  signal,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconDirective } from '../../icon.directive';
import { DeveloperApiService, DeveloperProfile } from '../../services/developer-api.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, IconDirective],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent implements OnChanges {
  private readonly developerApi = inject(DeveloperApiService);

  @Input() profile: DeveloperProfile | null = null;
  @Output() profileUpdated = new EventEmitter<DeveloperProfile>();
  @Output() error = new EventEmitter<string>();
  @Output() success = new EventEmitter<string>();

  readonly profileForm = { name: '', organization: '' };
  readonly busy = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['profile'] && this.profile) {
      this.profileForm.name = this.profile.name;
      this.profileForm.organization = this.profile.organization;
    }
  }

  async saveProfile(): Promise<void> {
    this.busy.set(true);
    try {
      const profile = await this.developerApi.updateProfile(this.profileForm);
      this.profileUpdated.emit(profile);
      this.success.emit('Profile updated.');
    } catch (error) {
      this.error.emit(this.errorText(error));
    } finally {
      this.busy.set(false);
    }
  }

  private errorText(error: unknown): string {
    const candidate = error as { error?: { error?: { message?: string } }; message?: string };
    return candidate.error?.error?.message ?? candidate.message ?? 'Could not update your profile.';
  }
}
