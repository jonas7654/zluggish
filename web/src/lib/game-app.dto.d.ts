export interface GameField {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'checkbox' | 'hidden' | 'file' | 'select';
  value?: string | boolean;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  autocomplete?: 'username' | 'new-password' | 'current-password' | 'one-time-code';
  matches?: string;
  autofocus?: boolean;
  when?: { field: string; value: string | boolean };
  options?: { value: string; label: string }[];
}

export interface GameForm {
  id: string;
  action: string;
  title?: string;
  fields: GameField[];
  buttons: { label: string; name?: string; value?: string; skipValidation?: boolean }[];
  navigation?: boolean;
  multipart?: boolean;
  confirmation?: string;
  method?: 'paid' | 'free';
  /** The page's main action, highlighted in Zwift orange. */
  primary?: boolean;
  /** Inputs are not saved settings (such as a sign-in password), so the form never reports unsaved changes. */
  transient?: boolean;
  /** The rider-list row: avatar, plus the sign-in email under the name when the rider has a real one. */
  rider?: { initials: string; photo: string | null; email: string | null };
}

export interface UploadJob {
  activity_id: number;
  provider: string;
  state: string;
}

export interface GamePageModel {
  kind:
    | 'login'
    | 'unlock'
    | 'add'
    | 'dashboard'
    | 'settings'
    | 'password'
    | 'connection'
    | 'workouts'
    | 'import'
    | 'confirm'
    | 'maintenance'
    | 'message';
  title: string;
  csrf: string;
  /** The server's release version, shown in the top bar. */
  version: string;
  forms: GameForm[];
  links?: { href: string; label: string }[];
  /** Shown as a back button beside the title; it navigates and never signs out. */
  back?: { href: string; label: string };
  paragraphs?: string[];
  message?: string;
  failed?: boolean;
  errorStatus?: 400 | 403 | 409;
  uploads?: UploadJob[];
  stravaMethod?: 'paid' | 'free';
}

export type FormResult<T> =
  | { ok: true; data: T; message?: string; redirectTo?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]>; reload?: boolean };

export interface GameSaved {
  page?: GamePageModel;
}
