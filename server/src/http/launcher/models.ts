import type { LauncherField, LauncherForm, LauncherPage } from '#src/dtos/launcher.dto';
import type { RuntimeEnv } from '#src/http/runtime';
import type { Context } from 'hono';

export function field(name: string, label: string, options: Omit<LauncherField, 'name' | 'label'> = {}): LauncherField {
  return { name, label, ...options };
}

export function hidden(name: string, value: string): LauncherField {
  return field(name, '', { type: 'hidden', value });
}

export function checkbox(name: string, label: string, value = false): LauncherField {
  return field(name, label, { type: 'checkbox', value });
}

export function secret(name: string, label: string, saved = false): LauncherField {
  return field(name, label, {
    type: 'password',
    placeholder: saved ? 'Saved; leave blank to keep' : '',
    autocomplete: 'new-password',
  });
}

export function form(
  id: string,
  action: string,
  fields: LauncherField[],
  label: string,
  options: Partial<LauncherForm> = {},
): LauncherForm {
  return {
    id,
    action,
    fields: [
      ...fields,
      ...(options.confirmation
        ? [field('confirm_action', `I confirm: ${options.confirmation}`, { type: 'checkbox', required: true })]
        : []),
    ],
    buttons: [{ label }],
    ...options,
  };
}

export function model(
  c: Context<RuntimeEnv>,
  kind: LauncherPage['kind'],
  title: string,
  forms: LauncherForm[],
  extra: Partial<LauncherPage> = {},
): LauncherPage {
  return { kind, title, csrf: c.get('browser').csrf, forms, ...extra };
}
