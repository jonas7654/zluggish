<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Layout from '../components/Layout.svelte';
  import RiderRow from '../components/RiderRow.svelte';
  import TextField from './TextField.svelte';

  type ApiValue = string | number | boolean | null | undefined | ApiValue[] | { [key: string]: ApiValue };

  type ApiPayload = { [key: string]: ApiValue };

  type Rider = {
    player_id: number;
    username: string;
    first_name: string;
    last_name: string;
    role: string;
    enabled: number;
    revision: number;
    has_password: boolean;
    connected: boolean;
    completion_deadline?: number | null;
  };

  type AuditEvent = {
    id: number;
    actor_kind: string;
    actor_player_id: number | null;
    action: string;
    timestamp: number;
  };

  type ManagedEvent = { id: number; name: string; description: string; eventStart: string; updateDate: string };

  type WorldSetting = {
    id: string;
    revision: number;
    overrides: Record<string, ApiValue>;
    fields: { name: string; kind: 'boolean' | 'number' | 'string'; value: string | number | boolean }[];
  };

  type RiderSettings = {
    revision: number;
    overrides: Record<string, boolean | string>;
    defaults: {
      ghosts: { enabled: boolean };
      uploads: { strava: { method: string } };
      workouts: { trainingpeaks: { bridgeFolder: string } };
    };
  };

  type Pending = { title: string; detail: string; label: string; destructive: boolean; confirm: () => Promise<void> };

  const filters = [
    ['all', 'All'],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled'],
    ['administrator', 'Administrators'],
    ['no-password', 'No password'],
  ] as const;

  const botCommands = [
    ['group', 'Group bots around the rider'],
    ['groupall', 'Group all bots around the rider'],
    ['autogroup', 'Keep bots grouped around the rider'],
    ['autogroupall', 'Keep all bots grouped around the rider'],
    ['stopautogroup', 'Stop automatic grouping'],
    ['disperse', 'Spread the bots out'],
    ['peloton', 'Set the RoboPacer peloton size'],
  ] as const;

  const pageSize = 25;

  let path = $state(location.pathname);
  let csrf = '';
  let version = $state('');
  let rider = $state<Rider | null>(null);
  let riders = $state<Rider[]>([]);
  let complete = $state(true);
  let loading = $state(true);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);
  let errorScope = $state('');
  let fieldErrors = $state<Record<string, string[]>>({});
  let conflict = $state<Rider | null>(null);
  let confirmation = $state(false);
  let confirmedUntil = $state(0);
  let pending = $state<Pending | null>(null);
  let operation = crypto.randomUUID();

  // Setup and sign-in.
  let mode = $state<'new' | 'existing'>('new');
  let key = $state('');
  let username = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let first = $state('');
  let last = $state('');

  // My account.
  let currentPassword = $state('');
  let settings = $state<RiderSettings | null>(null);
  let ghosts = $state(false);
  let stravaMethod = $state('paid');
  let bridgeFolder = $state('');

  // Riders.
  let search = $state('');
  let filter = $state<(typeof filters)[number][0]>('all');
  let page = $state(0);
  let creating = $state(false);
  let newFirst = $state('');
  let newLast = $state('');
  let newLogin = $state('');
  let newPassword = $state('');
  let newConfirm = $state('');
  let editFirst = $state('');
  let editLast = $state('');
  let editLogin = $state('');
  let targetPassword = $state('');
  let targetConfirm = $state('');
  let audit = $state<AuditEvent[] | null>(null);
  let riderSettings = $state<RiderSettings | null>(null);

  // Server.
  let serverConfig = $state<{ rows: [string, string][]; reason: string } | null>(null);
  let worldSettings = $state<WorldSetting[]>([]);
  let worldSetting = $state<WorldSetting | null>(null);
  let worldValues = $state<Record<string, string | number | boolean>>({});
  let events = $state<ManagedEvent[]>([]);
  let event = $state<ManagedEvent | null>(null);
  let eventDescription = $state('');
  let eventStart = $state('');
  let botRider = $state<number | null>(null);
  let botCommand = $state<(typeof botCommands)[number][0]>('group');
  let botArgument = $state('');

  const manage = $derived(path === '/manage' || path.startsWith('/manage/'));
  const administrator = $derived(rider?.role === 'administrator');
  const selectedId = $derived(Number(/^\/manage\/riders\/(\d+)$/.exec(path)?.[1] ?? 0));
  const selected = $derived(riders.find((r) => r.player_id === selectedId) ?? null);
  const withoutPassword = $derived(riders.filter((r) => !r.has_password).length);
  const connected = $derived(riders.filter((r) => r.connected));

  const filtered = $derived(
    riders.filter(
      (r) =>
        `${r.player_id} ${r.username} ${r.first_name} ${r.last_name}`.toLowerCase().includes(search.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'no-password' && !r.has_password) ||
          (filter === 'administrator' && r.role === 'administrator') ||
          (filter === 'enabled' && r.enabled === 1) ||
          (filter === 'disabled' && !r.enabled)),
    ),
  );

  const pages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));

  const title = $derived(
    !rider
      ? complete
        ? 'Sign in'
        : 'First administrator'
      : path === '/manage/server'
        ? 'Server'
        : manage
          ? 'Riders'
          : path === '/settings'
            ? 'My settings'
            : path === '/password'
              ? 'Change password'
              : 'My account',
  );

  const name = (r: Rider) => `${r.first_name} ${r.last_name}`.trim();
  const initials = (r: Rider) => `${r.first_name.charAt(0)}${r.last_name.charAt(0)}`.toUpperCase();
  const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const errors = (scope: string, field: string) => (errorScope === scope ? (fieldErrors[field] ?? []) : []);

  function actor(event: AuditEvent) {
    if (event.actor_kind === 'offline operator') return 'Offline operator';

    if (event.actor_player_id === null) return 'Setup';
    const known = riders.find((r) => r.player_id === event.actor_player_id);

    return known ? name(known) : `Rider ${event.actor_player_id}`;
  }

  async function api(url: string, method = 'GET', data?: ApiPayload) {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data !== undefined && { body: JSON.stringify(data) }),
    });

    const body = await response.json();

    if (body.csrf) csrf = body.csrf;

    if (!response.ok) {
      // The server answered, so a retry is a new operation. A lost response keeps the ID for a safe retry.
      if (method !== 'GET') operation = crypto.randomUUID();
      fieldErrors = body.fieldErrors ?? {};
      const scope = selected && `/api/manage/riders/${selected.player_id}`;

      if (response.status === 409 && scope && (url === scope || url.startsWith(`${scope}/`)))
        conflict = await api(scope);

      if (body.message === 'Password confirmation necessary.') confirmation = true;

      if (response.status === 401 && rider) {
        rider = null;
        go('/sign-in');
        await api('/api/setup');
        throw new Error('Your session ended. Sign in again.');
      }

      throw new Error(body.message || 'Request failed.');
    }

    if (method !== 'GET') operation = crypto.randomUUID();

    return body;
  }

  function go(next: string) {
    if (next !== path) history.pushState({}, '', next);
    path = next;
  }

  async function navigate(next: string) {
    go(next);
    message = '';
    await run(enter);
  }

  async function run(work: () => Promise<void>, scope = '') {
    if (busy) return;
    busy = true;
    message = '';
    failed = false;
    errorScope = scope;
    fieldErrors = {};

    try {
      await work();
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : 'Request failed.';
    } finally {
      busy = false;
    }
  }

  function done(text: string) {
    failed = false;
    message = text;
  }

  /** Loads what the current route shows. Direct navigation to any route works. */
  async function enter() {
    if (!rider) return;

    if (!manage) {
      if (path === '/settings') await loadSettings();

      return;
    }

    if (!administrator) return;
    await loadRiders();

    if (path === '/manage/server') await loadServer();

    if (selected) select(selected);
  }

  async function loadRiders() {
    riders = (await api('/api/manage/riders')).riders;
    confirmation = false;
  }

  async function loadServer() {
    const body = await api('/api/manage/settings');
    worldSettings = body.worldSettings;
    serverConfig = { rows: body.configuration, reason: body.reason };
    events = (await api('/api/manage/events')).events;
  }

  function applySettings(body: RiderSettings) {
    ghosts = Boolean(body.overrides['ghosts.enabled'] ?? body.defaults.ghosts.enabled);
    stravaMethod = String(body.overrides['uploads.strava.method'] ?? body.defaults.uploads.strava.method);
    bridgeFolder = String(
      body.overrides['workouts.trainingpeaks.bridgeFolder'] ?? body.defaults.workouts.trainingpeaks.bridgeFolder,
    );
  }

  async function loadSettings() {
    settings = await api('/api/me/settings');
    applySettings(settings!);
  }

  function select(target: Rider) {
    editFirst = target.first_name;
    editLast = target.last_name;
    editLogin = target.username;
    targetPassword = '';
    targetConfirm = '';
    audit = null;
    riderSettings = null;
    conflict = null;
  }

  async function openRider(target: Rider) {
    creating = false;
    go(`/manage/riders/${target.player_id}`);
    select(target);
    await tick();
    document.getElementById('rider-detail')?.focus();
  }

  function settingsBody(current: RiderSettings) {
    return {
      revision: current.revision,
      operation,
      overrides: {
        ...current.overrides,
        'ghosts.enabled': ghosts,
        'uploads.strava.method': stravaMethod,
        'workouts.trainingpeaks.bridgeFolder': bridgeFolder,
      },
    };
  }

  async function signIn() {
    if (!complete && mode === 'new' && password !== confirmPassword) {
      fieldErrors = { confirm: ['Passwords do not match.'] };
      throw new Error('Check the form fields.');
    }

    const body = complete
      ? await api('/api/session', 'POST', { username, password })
      : await api('/api/setup', 'POST', {
          mode,
          key,
          username,
          password,
          ...(mode === 'new' && { first_name: first, last_name: last }),
        });

    const setup = !complete;
    rider = body.rider;
    password = '';
    confirmPassword = '';
    key = '';
    complete = true;

    // The password typed during setup counts as the first management confirmation.
    if (setup) confirmedUntil = Date.now() + 900_000;
    go(setup ? '/manage' : '/');
    await enter();
  }

  async function signOut() {
    await api('/api/session', 'DELETE', {});
    await api('/api/setup');
    rider = null;
    riders = [];
    confirmedUntil = 0;
    go('/sign-in');
  }

  type RiderAction = 'disable' | 'enable' | 'role' | 'revoke-sessions' | 'password';

  function ask(action: RiderAction) {
    if (!selected) return;
    const who = name(selected);
    const progress = selected.connected ? ` ${who} is riding now and can lose unsaved ride progress.` : '';

    const choices = {
      disable: {
        title: `Disable ${who}?`,
        detail: `${who} cannot sign in until you enable the account again. A ride in progress can still be saved for up to four hours.`,
        label: 'Disable',
        destructive: true,
      },
      enable: {
        title: `Enable ${who}?`,
        detail: `${who} can sign in again. Old sessions stay ended.`,
        label: 'Enable',
        destructive: false,
      },
      role:
        selected.role === 'administrator'
          ? {
              title: `Remove the administrator role from ${who}?`,
              detail: `${who} can no longer open Manage. All sessions of ${who} end.${progress}`,
              label: 'Remove role',
              destructive: true,
            }
          : {
              title: `Give the administrator role to ${who}?`,
              detail: `${who} can manage riders and the server. All sessions of ${who} end.${progress}`,
              label: 'Give role',
              destructive: false,
            },
      'revoke-sessions': {
        title: `End all sessions of ${who}?`,
        detail: `${who} must sign in again everywhere. This also stops a ride in progress.${progress}`,
        label: 'End sessions',
        destructive: true,
      },
      password: {
        title: `Set a new password for ${who}?`,
        detail: `All sessions of ${who} end.${progress}`,
        label: 'Set password',
        destructive: false,
      },
    } satisfies Record<RiderAction, Omit<Pending, 'confirm'>>;

    pending = { ...choices[action], confirm: () => mutate(action) };
  }

  async function mutate(action: RiderAction) {
    if (!selected) return;

    if (action === 'password' && targetPassword !== targetConfirm) {
      fieldErrors = { confirm: ['Passwords do not match.'] };
      throw new Error('Check the form fields.');
    }

    const result: Rider = await api(
      `/api/manage/riders/${selected.player_id}/${action}`,
      action === 'role' ? 'PUT' : 'POST',
      {
        revision: selected.revision,
        operation,
        ...(action === 'password' && { password: targetPassword }),
        ...(action === 'role' && { role: selected.role === 'administrator' ? 'rider' : 'administrator' }),
      },
    );

    targetPassword = '';
    targetConfirm = '';
    await loadRiders();
    riders = riders.map((r) => (r.player_id === result.player_id ? { ...r, ...result } : r));

    const messages = {
      disable: result.completion_deadline
        ? 'Disabled. The current ride can be saved for up to four hours. A server restart ends this permission.'
        : 'Disabled.',
      enable: 'Enabled.',
      role: result.role === 'administrator' ? 'Administrator role given.' : 'Administrator role removed.',
      'revoke-sessions': 'Sessions ended.',
      password: 'Password set.',
    } satisfies Record<RiderAction, string>;

    done(messages[action]);
  }

  async function create() {
    if (newPassword !== newConfirm) {
      fieldErrors = { confirm: ['Passwords do not match.'] };
      throw new Error('Check the form fields.');
    }

    const created: Rider = await api('/api/manage/riders', 'POST', {
      operation,
      rider: { username: newLogin, password: newPassword, first_name: newFirst, last_name: newLast },
    });

    newFirst = '';
    newLast = '';
    newLogin = '';
    newPassword = '';
    newConfirm = '';
    creating = false;
    await loadRiders();
    await openRider(created);
    done(`${name(created)} can now sign in.`);
  }

  async function saveRider() {
    if (!selected) return;
    await api(`/api/manage/riders/${selected.player_id}`, 'PATCH', {
      revision: conflict?.revision ?? selected.revision,
      operation,
      username: editLogin,
      first_name: editFirst,
      last_name: editLast,
    });
    conflict = null;
    await loadRiders();
    done('Rider saved.');
  }

  type ServerAction = 'restart' | 'cancel-restart' | 'reload-bots';

  function serverOperation(
    action: ServerAction,
    label: string,
    detail: string,
    finished: string,
    destructive: boolean,
  ) {
    pending = {
      title: `${label}?`,
      detail,
      label,
      destructive,
      confirm: async () => {
        const body: { ok: boolean; message: string | null } = await api(`/api/manage/server/${action}`, 'POST', {
          operation,
        });

        if (!body.ok) throw new Error(body.message ?? 'Operation failed.');
        done(body.message ?? finished);
      },
    };
  }

  async function sendBots() {
    if (botRider === null) throw new Error('Choose a rider who is riding now.');

    const body: { ok: boolean; message: string | null } = await api('/api/manage/server/bots', 'POST', {
      operation,
      rider: botRider,
      command: botCommand,
      ...(botCommand === 'peloton' && botArgument && { argument: botArgument }),
    });

    if (!body.ok) throw new Error(body.message ?? 'Operation failed.');
    done(body.message ?? 'Sent to the bots.');
  }

  onMount(() => {
    const pop = () => {
      path = location.pathname;
      void run(enter);
    };

    window.addEventListener('popstate', pop);
    void run(async () => {
      const setup = await api('/api/setup');
      complete = setup.complete;
      version = setup.version ?? '';

      if (!complete) {
        go('/setup');

        return;
      }

      try {
        rider = (await api('/api/me')).rider;
      } catch {
        if (!['/sign-in', '/setup'].includes(path)) go('/sign-in');

        return;
      }

      if (['/sign-in', '/setup'].includes(path)) go('/');

      if (manage && !administrator) go('/');
      await enter();
    }).finally(() => {
      loading = false;
    });

    return () => window.removeEventListener('popstate', pop);
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && pending && !busy) pending = null;
  }}
/>

{#snippet link(href: string, label: string, current: boolean)}<a
    {href}
    aria-current={current ? 'page' : undefined}
    onclick={(e) => {
      e.preventDefault();
      void navigate(href);
    }}>{label}</a
  >{/snippet}

{#snippet chips(r: Rider)}
  {#if r.role === 'administrator'}<span class="chip admin">Administrator</span>{/if}
  {#if !r.enabled}<span class="chip muted">Disabled</span>{/if}
  {#if !r.has_password}<span class="chip alarm">No password</span>{/if}
  {#if r.connected}<span class="chip riding">Riding now</span>{/if}
{/snippet}

{#snippet bar()}
  {#if rider}<nav class="top" aria-label="Main">
      {@render link('/', 'My account', !manage)}
      {#if administrator}{@render link('/manage', 'Manage', manage)}{/if}
      <button class="link" disabled={busy} onclick={() => run(signOut)}>Sign out</button>
    </nav>{/if}
{/snippet}

<div class="app" class:management={manage && administrator}>
  <Layout {title} page={manage ? 'manage' : 'account'} {version} actions={bar}>
    {#if message}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>{message}</p>{/if}

    {#if loading}<p role="status">Loading…</p>
    {:else if !rider}
      {#if path === '/setup' && complete}
        <section class="panel narrow">
          <p>Setup is complete. Sign in with your login name and password.</p>
          <button class="primary" onclick={() => navigate('/sign-in')}>Go to sign-in</button>
        </section>
      {:else}
        <form
          class="narrow"
          onsubmit={(e) => {
            e.preventDefault();
            void run(signIn, 'sign-in');
          }}
        >
          {#if !complete}
            <p class="lead">
              Create the first administrator for this server. Find the setup key in the server console.
            </p>
            <div class="choice" role="radiogroup" aria-label="Setup method">
              <label class:checked={mode === 'new'}
                ><input type="radio" bind:group={mode} value="new" /> Create a new rider</label
              >
              <label class:checked={mode === 'existing'}
                ><input type="radio" bind:group={mode} value="existing" /> Use an existing rider</label
              >
            </div>
            <TextField
              id="setup-key"
              label="Setup key"
              bind:value={key}
              required
              maxlength={200}
              hint="Case, spaces and hyphens do not matter."
              errors={errors('sign-in', 'key')}
            />
            {#if mode === 'new'}
              <TextField
                id="setup-first"
                label="First name"
                bind:value={first}
                required
                maxlength={50}
                errors={errors('sign-in', 'first_name')}
              />
              <TextField
                id="setup-last"
                label="Last name"
                bind:value={last}
                maxlength={50}
                errors={errors('sign-in', 'last_name')}
              />
            {/if}
          {/if}
          <TextField
            id="sign-in-login"
            label="Login name"
            bind:value={username}
            autocomplete="username"
            required
            maxlength={254}
            errors={errors('sign-in', 'username')}
          />
          <TextField
            id="sign-in-password"
            label="Password"
            password
            bind:value={password}
            autocomplete={complete || mode === 'existing' ? 'current-password' : 'new-password'}
            required
            maxlength={1024}
            errors={errors('sign-in', 'password')}
          />
          {#if !complete && mode === 'new'}
            <TextField
              id="setup-confirm"
              label="Confirm password"
              password
              bind:value={confirmPassword}
              autocomplete="new-password"
              required
              errors={errors('sign-in', 'confirm')}
            />
          {/if}
          <button class="primary" disabled={busy}>{complete ? 'Sign in' : 'Complete setup'}</button>
        </form>
      {/if}
    {:else if manage && administrator}
      <nav class="sub" aria-label="Manage">
        {@render link('/manage', 'Riders', path !== '/manage/server')}
        {@render link('/manage/server', 'Server', path === '/manage/server')}
        {#if confirmedUntil > 0 && !confirmation}<span class="deadline"
            >Management access until {time(confirmedUntil)}</span
          >{/if}
      </nav>

      {#if confirmation}
        <form
          class="panel confirm narrow"
          onsubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const body = await api('/api/session/confirm', 'POST', { password: currentPassword });
              currentPassword = '';
              confirmedUntil = body.confirmedUntil;
              await enter();
            }, 'confirm');
          }}
        >
          <h2>Confirm your password to manage the server.</h2>
          <p>Access lasts 15 minutes from now. Your unsaved changes stay in place.</p>
          <TextField
            id="confirm-password"
            label="Password"
            password
            bind:value={currentPassword}
            autocomplete="current-password"
            required
            errors={errors('confirm', 'password')}
          />
          <button class="primary" disabled={busy}>Confirm</button>
        </form>
      {/if}

      <div inert={confirmation} class:dimmed={confirmation}>
        {#if path === '/manage/server'}
          <div class="columns">
            <section class="panel">
              <h2>Restart</h2>
              <p class="muted">A restart disconnects every rider when the countdown ends.</p>
              <div class="actions">
                <button
                  class="danger"
                  disabled={busy}
                  onclick={() =>
                    serverOperation(
                      'restart',
                      'Restart the server',
                      'Riders get a countdown in the game. Every rider is disconnected when it ends.',
                      'Restart scheduled.',
                      true,
                    )}>Restart with countdown</button
                >
                <button
                  disabled={busy}
                  onclick={() =>
                    serverOperation(
                      'cancel-restart',
                      'Cancel the restart',
                      'The countdown stops.',
                      'Restart canceled.',
                      false,
                    )}>Cancel restart</button
                >
                <button
                  disabled={busy}
                  onclick={() =>
                    serverOperation(
                      'reload-bots',
                      'Reload bots',
                      'Bots restart with the current world settings.',
                      'Bots reloaded.',
                      false,
                    )}>Reload bots</button
                >
              </div>
            </section>

            <form
              class="panel"
              onsubmit={(e) => {
                e.preventDefault();
                void run(sendBots, 'bots');
              }}
            >
              <h2>Bots</h2>
              {#if connected.length === 0}
                <p class="muted">Bot commands act around a rider who is riding now. Nobody is riding.</p>
              {:else}
                <label for="bot-rider">Rider</label>
                <select id="bot-rider" bind:value={botRider} required>
                  <option value={null} disabled>Choose a rider</option>
                  {#each connected as r (r.player_id)}<option value={r.player_id}>{name(r)}</option>{/each}
                </select>
                <label for="bot-command">Command</label>
                <select id="bot-command" bind:value={botCommand}>
                  {#each botCommands as [value, label] (value)}<option {value}>{label}</option>{/each}
                </select>
                {#if botCommand === 'peloton'}
                  <TextField
                    id="bot-argument"
                    label="Peloton size"
                    bind:value={botArgument}
                    maxlength={3}
                    hint="0 to 200 bots, or off. Leave empty to see the current size."
                    errors={errors('bots', 'argument')}
                  />
                {/if}
                <button disabled={busy}>Send to bots</button>
              {/if}
            </form>
          </div>

          <section class="panel">
            <h2>World settings</h2>
            {#if worldSettings.length === 0}
              <p class="muted">No world settings are stored yet. Riders create them with blob and peloton commands.</p>
            {:else}
              <div class="pills" role="group" aria-label="World settings">
                {#each worldSettings as item (item.id)}<button
                    aria-pressed={worldSetting?.id === item.id}
                    onclick={() => {
                      worldSetting = item;
                      worldValues = Object.fromEntries(item.fields.map((f) => [f.name, f.value]));
                    }}>{item.id}</button
                  >{/each}
              </div>
            {/if}
            {#if worldSetting}
              <form
                class="inset"
                onsubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await api('/api/manage/settings', 'PATCH', {
                      id: worldSetting!.id,
                      revision: worldSetting!.revision,
                      operation,
                      values: worldValues,
                    });
                    worldSetting = { ...worldSetting!, ...result };
                    done('World settings saved. Reload bots to apply them.');
                  }, 'world');
                }}
              >
                <div class="grid">
                  {#each worldSetting.fields as { name: field, kind, value } (field)}
                    {#if kind === 'boolean'}<label class="check"
                        ><input
                          type="checkbox"
                          checked={value === true}
                          onchange={(e) => {
                            worldValues[field] = e.currentTarget.checked;
                          }}
                        />
                        {field}</label
                      >
                    {:else}<div>
                        <label for={`world-${field}`}>{field}</label><input
                          id={`world-${field}`}
                          type={kind === 'number' ? 'number' : 'text'}
                          step="any"
                          {value}
                          onchange={(e) => {
                            worldValues[field] =
                              kind === 'number' ? e.currentTarget.valueAsNumber : e.currentTarget.value;
                          }}
                        />
                      </div>{/if}
                  {/each}
                </div>
                <button disabled={busy}>Save world settings</button>
              </form>
            {/if}
          </section>

          <section class="panel">
            <h2>Events</h2>
            {#if events.length === 0}
              <p class="muted">No private events. Riders create them in the Companion app.</p>
            {:else}
              <ul class="plain">
                {#each events as item (item.id)}<li>
                    <button
                      class="row"
                      aria-pressed={event?.id === item.id}
                      onclick={() => {
                        event = item;
                        eventDescription = item.description;
                        eventStart = item.eventStart;
                      }}
                      ><span>{item.name}</span><span class="num muted"
                        >{new Date(item.eventStart).toLocaleString()}</span
                      ></button
                    >
                  </li>{/each}
              </ul>
            {/if}
            {#if event}
              <form
                class="inset"
                onsubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api(`/api/manage/events/${event!.id}`, 'PATCH', {
                      operation,
                      revision: event!.updateDate,
                      changes: { description: eventDescription, eventStart },
                    });
                    event = null;
                    events = (await api('/api/manage/events')).events;
                    done('Event saved.');
                  }, 'event');
                }}
              >
                <TextField id="event-description" label="Description" bind:value={eventDescription} />
                <TextField
                  id="event-start"
                  label="Start time (UTC)"
                  bind:value={eventStart}
                  required
                  hint="For example 2026-11-20T18:00:00.000Z"
                  errors={errors('event', 'changes')}
                />
                <div class="actions">
                  <button disabled={busy}>Save event</button>
                  <button
                    type="button"
                    class="danger"
                    disabled={busy}
                    onclick={() => {
                      const target = event!;
                      pending = {
                        title: `Delete ${target.name}?`,
                        detail: 'Invited riders lose the event. This cannot be undone.',
                        label: 'Delete event',
                        destructive: true,
                        confirm: async () => {
                          await api(`/api/manage/events/${target.id}`, 'DELETE', {
                            operation,
                            revision: target.updateDate,
                          });
                          event = null;
                          events = (await api('/api/manage/events')).events;
                          done('Event deleted.');
                        },
                      };
                    }}>Delete event</button
                  >
                </div>
              </form>
            {/if}
          </section>

          {#if serverConfig}
            <section class="panel">
              <h2>Configuration</h2>
              <p class="muted">{serverConfig.reason}</p>
              <dl class="config">
                {#each serverConfig.rows as [field, value] (field)}<div>
                    <dt>{field}</dt>
                    <dd class="num" class:muted={!value}>{value || 'Not set'}</dd>
                  </div>{/each}
              </dl>
            </section>
          {/if}
        {:else}
          <div class="riders-head">
            <div class="search">
              <label for="rider-search">Search riders</label>
              <input
                id="rider-search"
                type="search"
                bind:value={search}
                oninput={() => {
                  page = 0;
                }}
                placeholder="Name, login name or player ID"
              />
            </div>
            {#if !creating}<button
                class="primary"
                onclick={() => {
                  creating = true;
                  go('/manage');
                }}>Create rider</button
              >{/if}
          </div>
          <div class="pills" role="group" aria-label="Filter riders">
            {#each filters as [value, label] (value)}<button
                aria-pressed={filter === value}
                onclick={() => {
                  filter = value;
                  page = 0;
                }}>{label}</button
              >{/each}
          </div>

          {#if withoutPassword > 0 && filter !== 'no-password'}
            <p class="warning">
              {withoutPassword === 1 ? '1 rider has' : `${withoutPassword} riders have`} no password and cannot sign in.
              Set a password for each rider.
              <button
                class="link"
                onclick={() => {
                  filter = 'no-password';
                  page = 0;
                }}>Show {withoutPassword === 1 ? 'this rider' : 'these riders'}</button
              >
            </p>
          {/if}

          <div class="riders">
            <div>
              {#if riders.length <= 1}
                <p class="empty">No other riders yet. Create a rider so that somebody else can ride on this server.</p>
              {/if}
              {#if filtered.length === 0 && riders.length > 1}
                <p class="empty">No riders match. Clear the search or choose another filter.</p>
              {/if}
              <ul class="plain list">
                {#each filtered.slice(page * pageSize, page * pageSize + pageSize) as r (r.player_id)}<li>
                    <button
                      class="rider"
                      aria-current={selected?.player_id === r.player_id ? 'true' : undefined}
                      onclick={() => openRider(r)}
                      ><span class="identity"
                        ><RiderRow initials={initials(r)} name={name(r)} detail={r.username} /></span
                      ><span class="facts"><span class="num id">#{r.player_id}</span>{@render chips(r)}</span></button
                    >
                  </li>{/each}
              </ul>
              {#if pages > 1}
                <div class="pager">
                  <button disabled={page === 0} onclick={() => page--}>Previous</button>
                  <span class="num muted">Page {page + 1} of {pages}</span>
                  <button disabled={page + 1 >= pages} onclick={() => page++}>Next</button>
                </div>
              {/if}
            </div>

            <div class="detail">
              {#if creating}
                <form
                  class="panel"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void run(create, 'create');
                  }}
                >
                  <h2>Create rider</h2>
                  <p class="muted">
                    The rider signs in with this login name and password. New riders have no administrator role.
                  </p>
                  <TextField
                    id="new-first"
                    label="First name"
                    bind:value={newFirst}
                    required
                    maxlength={50}
                    errors={errors('create', 'first_name')}
                  />
                  <TextField
                    id="new-last"
                    label="Last name"
                    bind:value={newLast}
                    maxlength={50}
                    errors={errors('create', 'last_name')}
                  />
                  <TextField
                    id="new-login"
                    label="Login name"
                    bind:value={newLogin}
                    required
                    maxlength={254}
                    errors={errors('create', 'username')}
                  />
                  <TextField
                    id="new-password"
                    label="Password"
                    password
                    bind:value={newPassword}
                    autocomplete="new-password"
                    required
                    errors={errors('create', 'password')}
                  />
                  <TextField
                    id="new-confirm"
                    label="Confirm password"
                    password
                    bind:value={newConfirm}
                    autocomplete="new-password"
                    required
                    errors={errors('create', 'confirm')}
                  />
                  <div class="actions">
                    <button class="primary" disabled={busy}>Create rider</button>
                    <button type="button" onclick={() => (creating = false)}>Cancel</button>
                  </div>
                </form>
              {:else if selected}
                <section class="panel" id="rider-detail" tabindex="-1" aria-labelledby="rider-name">
                  <div class="detail-head">
                    <span class="identity"
                      ><RiderRow initials={initials(selected)} name={name(selected)} detail={selected.username} /></span
                    >
                    <span class="num id">#{selected.player_id}</span>
                  </div>
                  <h2 id="rider-name" class="visually-hidden">{name(selected)}</h2>
                  <p class="facts">
                    {@render chips(selected)}
                    {#if selected.enabled && selected.has_password && selected.role !== 'administrator'}<span
                        class="chip muted">Rider</span
                      >{/if}
                  </p>
                  {#if selected.completion_deadline}
                    <p class="muted">
                      The current ride can be saved until <span class="num">{time(selected.completion_deadline)}</span>.
                    </p>
                  {/if}

                  {#if conflict}
                    <div class="conflict" role="alert">
                      <p>This rider changed on the server. Your draft is kept. Review the server version:</p>
                      <dl class="config">
                        <div>
                          <dt>Name</dt>
                          <dd>{name(conflict)}</dd>
                        </div>
                        <div>
                          <dt>Login name</dt>
                          <dd>{conflict.username}</dd>
                        </div>
                        <div>
                          <dt>Role</dt>
                          <dd>{conflict.role === 'administrator' ? 'Administrator' : 'Rider'}</dd>
                        </div>
                        <div>
                          <dt>Account</dt>
                          <dd>{conflict.enabled ? 'Enabled' : 'Disabled'}</dd>
                        </div>
                      </dl>
                      <button
                        onclick={() => {
                          riders = riders.map((r) => (r.player_id === conflict!.player_id ? conflict! : r));
                          conflict = null;
                        }}>Use the server version</button
                      >
                    </div>
                  {/if}

                  <form
                    class="inset"
                    onsubmit={(e) => {
                      e.preventDefault();
                      void run(saveRider, 'edit');
                    }}
                  >
                    <h3>Name and login</h3>
                    {#if selected.connected}<p class="muted">
                        Names can change only while the rider is not riding.
                      </p>{/if}
                    <TextField
                      id="edit-first"
                      label="First name"
                      bind:value={editFirst}
                      required
                      maxlength={50}
                      errors={errors('edit', 'first_name')}
                    />
                    <TextField
                      id="edit-last"
                      label="Last name"
                      bind:value={editLast}
                      maxlength={50}
                      errors={errors('edit', 'last_name')}
                    />
                    <TextField
                      id="edit-login"
                      label="Login name"
                      bind:value={editLogin}
                      required
                      maxlength={254}
                      errors={errors('edit', 'username')}
                    />
                    <button disabled={busy || selected.connected}>Save rider</button>
                  </form>

                  {#if selected.player_id !== rider.player_id}
                    <form
                      class="inset"
                      onsubmit={(e) => {
                        e.preventDefault();
                        ask('password');
                      }}
                    >
                      <h3>{selected.has_password ? 'Password' : 'Set a password'}</h3>
                      {#if !selected.has_password}<p class="muted">
                          This rider cannot sign in until a password is set.
                        </p>{/if}
                      <TextField
                        id="target-password"
                        label="New password"
                        password
                        bind:value={targetPassword}
                        autocomplete="new-password"
                        required
                        errors={errors('password', 'password')}
                      />
                      <TextField
                        id="target-confirm"
                        label="Confirm password"
                        password
                        bind:value={targetConfirm}
                        autocomplete="new-password"
                        required
                        errors={errors('password', 'confirm')}
                      />
                      <button disabled={busy}>Set password</button>
                    </form>
                  {:else}
                    <p class="muted">Change your own password in My account.</p>
                  {/if}

                  <div class="inset">
                    <h3>Access</h3>
                    <div class="actions">
                      {#if selected.enabled}<button class="danger" disabled={busy} onclick={() => ask('disable')}
                          >Disable</button
                        >{:else}<button disabled={busy} onclick={() => ask('enable')}>Enable</button>{/if}
                      <button
                        class:danger={selected.role === 'administrator'}
                        disabled={busy}
                        onclick={() => ask('role')}
                        >{selected.role === 'administrator'
                          ? 'Remove administrator role'
                          : 'Give administrator role'}</button
                      >
                      <button class="danger" disabled={busy} onclick={() => ask('revoke-sessions')}>End sessions</button
                      >
                    </div>
                  </div>

                  <div class="inset">
                    <h3>More</h3>
                    <div class="actions">
                      {#if selected.player_id !== rider.player_id}<button
                          disabled={busy}
                          onclick={() =>
                            run(async () => {
                              riderSettings = await api(`/api/manage/riders/${selected!.player_id}/settings`);
                              applySettings(riderSettings!);
                            })}>Rider settings</button
                        >{/if}
                      <button
                        disabled={busy}
                        onclick={() =>
                          run(async () => {
                            audit = (await api(`/api/manage/riders/${selected!.player_id}/audit`)).events;
                          })}>Change history</button
                      >
                    </div>
                  </div>

                  {#if riderSettings}
                    <form
                      class="inset"
                      onsubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          riderSettings = await api(
                            `/api/manage/riders/${selected!.player_id}/settings`,
                            'PATCH',
                            settingsBody(riderSettings!),
                          );
                          done('Rider settings saved.');
                        }, 'rider-settings');
                      }}
                    >
                      <h3>Rider settings</h3>
                      {@render settingsFields(riderSettings)}
                      <div class="actions">
                        <button disabled={busy}>Save rider settings</button>
                        <button type="button" onclick={() => (riderSettings = null)}>Close</button>
                      </div>
                    </form>
                  {/if}

                  {#if audit}
                    <div class="inset">
                      <h3>Change history</h3>
                      {#if audit.length === 0}<p class="muted">No changes recorded yet.</p>{:else}
                        <ol class="plain history">
                          {#each audit as item (item.id)}<li>
                              <span>{item.action.replaceAll('-', ' ')}</span>
                              <span class="muted">{actor(item)}</span>
                              <time class="num muted" datetime={new Date(item.timestamp).toISOString()}
                                >{new Date(item.timestamp).toLocaleString()}</time
                              >
                            </li>{/each}
                        </ol>
                      {/if}
                    </div>
                  {/if}
                </section>
              {:else if riders.length > 0}
                <p class="empty">Choose a rider to see their account, set a password, or change their access.</p>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <nav class="sub" aria-label="My account">
        {@render link('/', 'Overview', path !== '/settings' && path !== '/password')}
        {@render link('/settings', 'Settings', path === '/settings')}
        {@render link('/password', 'Password', path === '/password')}
      </nav>
      {#if path === '/settings'}
        {#if settings}
          <form
            class="panel narrow"
            onsubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                settings = await api('/api/me/settings', 'PATCH', settingsBody(settings!));
                done('Settings saved.');
              }, 'settings');
            }}
          >
            {@render settingsFields(settings)}
            <button class="primary" disabled={busy}>Save settings</button>
          </form>
        {/if}
      {:else if path === '/password'}
        <form
          class="panel narrow"
          onsubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (password !== confirmPassword) {
                fieldErrors = { confirm: ['Passwords do not match.'] };
                throw new Error('Check the form fields.');
              }
              await api('/api/me/password', 'POST', { current_password: currentPassword, password });
              await api('/api/setup');
              rider = null;
              currentPassword = '';
              password = '';
              confirmPassword = '';
              go('/sign-in');
              done('Password changed. Sign in with the new password.');
            }, 'password');
          }}
        >
          <p class="muted">You sign out everywhere, also in the game.</p>
          <TextField
            id="own-current"
            label="Current password"
            password
            bind:value={currentPassword}
            autocomplete="current-password"
            required
            errors={errors('password', 'current_password')}
          />
          <TextField
            id="own-new"
            label="New password"
            password
            bind:value={password}
            autocomplete="new-password"
            required
            errors={errors('password', 'password')}
          />
          <TextField
            id="own-confirm"
            label="Confirm new password"
            password
            bind:value={confirmPassword}
            autocomplete="new-password"
            required
            errors={errors('password', 'confirm')}
          />
          <button class="primary" disabled={busy}>Change password</button>
        </form>
      {:else}
        <section class="panel narrow">
          <div class="detail-head">
            <span class="identity"
              ><RiderRow initials={initials(rider)} name={name(rider)} detail={rider.username} /></span
            >
            <span class="num id">#{rider.player_id}</span>
          </div>
          <dl class="config">
            <div>
              <dt>Login name</dt>
              <dd>{rider.username}</dd>
            </div>
            <div>
              <dt>Player ID</dt>
              <dd class="num">{rider.player_id}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{administrator ? 'Administrator' : 'Rider'}</dd>
            </div>
          </dl>
          <p class="muted">Use the same login name and password in the game and in the Companion app.</p>
        </section>
      {/if}
    {/if}
  </Layout>
</div>

{#snippet settingsFields(current: RiderSettings)}
  <label class="check"><input type="checkbox" bind:checked={ghosts} /> Ride with ghosts</label>
  <p class="source">{'ghosts.enabled' in current.overrides ? 'Set for this rider' : 'Server default'}</p>
  <label for="strava-method">Strava upload method</label>
  <select id="strava-method" bind:value={stravaMethod}>
    <option value="paid">Strava API</option>
    <option value="free">Session cookie</option>
  </select>
  <p class="source">{'uploads.strava.method' in current.overrides ? 'Set for this rider' : 'Server default'}</p>
  <TextField id="bridge-folder" label="TrainingPeaks export folder" bind:value={bridgeFolder} maxlength={500} />
  <p class="source">
    {'workouts.trainingpeaks.bridgeFolder' in current.overrides ? 'Set for this rider' : 'Server default'}
  </p>
{/snippet}

{#if pending}
  <div class="scrim">
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-detail"
    >
      <h2 id="dialog-title">{pending.title}</h2>
      <p id="dialog-detail">{pending.detail}</p>
      <div class="actions">
        <!-- svelte-ignore a11y_autofocus (the safe choice takes focus when the dialog opens) -->
        <button autofocus disabled={busy} onclick={() => (pending = null)}>Cancel</button>
        <button
          class={pending.destructive ? 'danger' : 'primary'}
          disabled={busy}
          onclick={() => {
            const chosen = pending!;
            pending = null;
            void run(chosen.confirm, chosen.label === 'Set password' ? 'password' : '');
          }}>{pending.label}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  /* Management: a wider column, a darker world for dense lists, and the orange edge under the bar. */
  :global(body:has(.management))::before {
    background:
      linear-gradient(rgb(14 20 30 / 0.72), rgb(14 20 30 / 0.86)),
      url('../../../assets/cdn/style/background.jpg') center / cover no-repeat;
  }
  .management :global(.bar) {
    border-bottom: 3px solid var(--orange);
    padding-inline: max(1.5rem, calc((100% - 72rem) / 2));
  }
  .management :global(main) {
    max-width: 72rem;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    margin: 0 0 0 1.25rem;
  }
  .top :global(a),
  .sub :global(a) {
    padding-block: 0.2rem;
    border-bottom: 2px solid transparent;
  }
  .top :global(a[aria-current]),
  .sub :global(a[aria-current]) {
    border-bottom-color: var(--orange);
  }
  .sub {
    align-items: baseline;
  }
  .deadline {
    margin-left: auto;
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  button.link {
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font-size: 0.8125rem;
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
  .top button.link {
    text-decoration: none;
  }
  .warning button.link {
    color: var(--alarm);
    font-size: inherit;
    text-transform: none;
    letter-spacing: 0;
  }

  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .narrow {
    max-width: 34rem;
  }
  .inset {
    background: none;
    padding: 1rem 0 0;
    margin: 1rem 0 0;
    border-top: 1px solid var(--line);
    border-radius: 0;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-size: 0.9375rem;
    font-weight: 800;
  }
  .lead {
    margin-top: 0;
  }
  .muted,
  .source {
    color: var(--muted);
  }
  .source {
    margin: 0.25rem 0 0.5rem;
    font-size: 0.8125rem;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
  }
  .warning {
    max-width: none;
    padding: 0.7rem 0.9rem;
    border-left: 3px solid #ff6b57;
    border-radius: 0 10px 10px 0;
    background: linear-gradient(rgb(255 90 70 / 0.16), rgb(255 90 70 / 0.16)), var(--glass);
    color: var(--alarm);
  }
  .empty {
    color: var(--muted);
    padding: 1rem 0;
  }
  .dimmed {
    opacity: 0.35;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions button {
    margin: 0.75rem 0 0;
  }
  button.danger {
    border-color: rgb(255 179 166 / 0.75);
    color: var(--alarm);
  }
  button.danger:hover {
    background: rgb(255 90 70 / 0.14);
  }

  .choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .choice label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    padding: 0.65rem 0.8rem;
    border: 2px solid var(--line);
    border-radius: 10px;
    color: var(--text);
    cursor: pointer;
  }
  .choice label.checked {
    border-color: var(--orange);
    background: var(--glass-raised);
  }
  .choice input {
    flex: none;
    width: auto;
    margin: 0;
    accent-color: var(--orange);
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text);
  }

  .riders-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .riders-head .primary {
    margin: 0;
  }
  .search {
    flex: 1 1 18rem;
  }
  .search label {
    margin-top: 0;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.9rem 0 1rem;
  }
  .pills button {
    margin: 0;
    padding: 0.35rem 0.85rem;
    border-width: 1px;
    border-color: var(--line);
    border-radius: 999px;
    font-size: 0.8125rem;
    text-transform: none;
    letter-spacing: 0;
    background: rgb(36 47 62 / 0.6);
  }
  .pills button[aria-pressed='true'] {
    border-color: var(--text);
    background: var(--glass-raised);
  }

  .riders {
    display: grid;
    gap: 1rem;
    align-items: start;
  }
  @media (min-width: 62rem) {
    .riders {
      grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
    }
    .detail {
      position: sticky;
      top: 1rem;
    }
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li + li {
    margin-top: 0.4rem;
  }
  button.rider,
  button.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    margin: 0;
    padding: 0.5rem 0.75rem 0.5rem 0.6rem;
    border: 2px solid transparent;
    border-radius: 12px;
    background: var(--glass);
    font-size: 0.9375rem;
    text-transform: none;
    letter-spacing: 0;
    text-align: left;
  }
  button.row {
    margin-top: 0.4rem;
    font-weight: 600;
  }
  button.rider:hover,
  button.row:hover {
    background: var(--glass-raised);
    border-color: var(--orange);
  }
  button.rider[aria-current],
  button.row[aria-pressed='true'] {
    background: var(--glass-raised);
    border-color: var(--text);
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    min-width: 0;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    max-width: none;
  }
  .id {
    color: var(--muted);
    font-weight: 600;
  }
  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }
  .detail-head + h2 + .facts {
    justify-content: flex-start;
  }
  .detail-head :global(.who > span) {
    font-size: 1.125rem;
    font-weight: 800;
  }
  .detail :global(.panel:focus) {
    outline: none;
  }

  /* Status uses text and color together, never color alone. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.1rem 0.55rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 800;
    white-space: nowrap;
  }
  .chip.admin {
    border-color: rgb(255 255 255 / 0.6);
  }
  .chip.muted {
    color: var(--muted);
  }
  .chip.alarm {
    border-color: rgb(255 179 166 / 0.6);
    color: var(--alarm);
  }
  .chip.alarm::before {
    content: '';
    width: 0.7rem;
    height: 0.6rem;
    background: currentColor;
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
  }
  .chip.riding::before {
    content: '';
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--orange);
  }

  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .pager button {
    margin: 0;
  }

  .columns {
    display: grid;
    gap: 0 1rem;
  }
  @media (min-width: 52rem) {
    .columns {
      grid-template-columns: 1fr 1fr;
    }
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0 1rem;
  }
  .config {
    display: grid;
    gap: 0.35rem;
    margin: 0.5rem 0 0;
  }
  .config div {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) minmax(0, 1.4fr);
    gap: 0.75rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }
  .config dt {
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .config dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .history li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 0.75rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--line);
  }
  .history li span:first-child::first-letter {
    text-transform: uppercase;
  }
  .history time {
    grid-column: 1 / -1;
    font-size: 0.8125rem;
  }
  .conflict {
    margin: 0.75rem 0;
    padding: 0.75rem 0.9rem;
    border-left: 3px solid var(--text);
    background: var(--glass-raised);
    border-radius: 0 10px 10px 0;
  }
  .conflict p {
    margin-top: 0;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(8 12 18 / 0.6);
  }
  .dialog {
    width: min(30rem, 100%);
    box-sizing: border-box;
    padding: 1.25rem 1.25rem 1rem;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgb(36 47 62 / 0.97);
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.45);
    animation: rise 160ms ease-out;
  }
  .dialog h2 {
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.125rem;
  }
  .dialog .actions {
    justify-content: flex-end;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 500px) {
    .management :global(.bar) {
      padding-inline: 1rem;
    }
    /* The bar wraps: brand on the first line, navigation on the second. */
    .app :global(.bar) {
      flex-wrap: wrap;
      row-gap: 0.5rem;
    }
    .app :global(.bar .version) {
      display: none;
    }
    .top {
      flex: 1 0 100%;
      margin: 0;
      gap: 1rem;
    }
    button.rider .identity {
      flex: 1 0 100%;
    }
    .panel {
      padding: 0.9rem;
    }
    button.rider {
      flex-wrap: wrap;
    }
    .facts {
      justify-content: flex-start;
      padding-left: 3.25rem;
    }
    .config div {
      grid-template-columns: 1fr;
      gap: 0.1rem;
    }
  }
</style>
