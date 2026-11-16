<script lang="ts">
  import { onMount } from 'svelte';
  import Layout from '../components/Layout.svelte';
  import FieldErrors from '../components/FieldErrors.svelte';

  type ApiValue = string | number | boolean | null | undefined | { [key: string]: ApiValue };

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

  let path = $state(location.pathname);
  let csrf = '';
  let rider = $state<Rider | null>(null);
  let riders = $state<Rider[]>([]);
  let complete = $state(true);
  let loading = $state(true);
  let busy = $state(false);
  let message = $state('');
  let fieldErrors = $state<Record<string, string[]>>({});
  let conflictData = $state('');
  let confirmation = $state(false);
  let username = $state('');
  let password = $state('');
  let currentPassword = $state('');
  let confirmPassword = $state('');
  let key = $state('');
  let first = $state('');
  let last = $state('');
  let mode = $state('new');
  let search = $state('');

  type ManagedEvent = { id: number; name: string; description: string; eventStart: string; updateDate: string };

  let events = $state<ManagedEvent[]>([]);
  let event = $state<ManagedEvent | null>(null);
  let eventDescription = $state('');
  let eventStart = $state('');

  type WorldSetting = {
    id: string;
    revision: number;
    overrides: Record<string, ApiValue>;
    fields: { name: string; kind: 'boolean' | 'number' | 'string'; value: string | number | boolean }[];
  };

  let worldSettings = $state<WorldSetting[]>([]);
  let worldSetting = $state<WorldSetting | null>(null);
  let worldValues = $state<Record<string, string | number | boolean>>({});

  let filter = $state('all');
  let selected = $state<Rider | null>(null);
  let targetPassword = $state('');
  let operation = crypto.randomUUID();
  let audit = $state('');
  let editFirst = $state('');
  let editLast = $state('');
  let editLogin = $state('');

  let settings = $state<{ revision: number; overrides: Record<string, boolean | string>; defaults: unknown } | null>(
    null,
  );

  let settingsPlayer = $state<number | null>(null);
  let ghosts = $state(false);
  let stravaMethod = $state('paid');
  let bridgeFolder = $state('');
  let page = $state(0);

  async function openSettings(player: number) {
    const body = await api(manage ? `/api/manage/riders/${player}/settings` : '/api/me/settings');
    settings = body;
    settingsPlayer = player;
    ghosts = body.overrides['ghosts.enabled'] ?? body.defaults.ghosts.enabled;
    stravaMethod = body.overrides['uploads.strava.method'] ?? body.defaults.uploads.strava.method;
    bridgeFolder =
      body.overrides['workouts.trainingpeaks.bridgeFolder'] ?? body.defaults.workouts.trainingpeaks.bridgeFolder;
  }

  async function saveSettings() {
    if (!settings) return;
    settings = await api(manage ? `/api/manage/riders/${settingsPlayer}/settings` : '/api/me/settings', 'PATCH', {
      revision: settings.revision,
      operation,
      overrides: {
        ...settings.overrides,
        'ghosts.enabled': ghosts,
        'uploads.strava.method': stravaMethod,
        'workouts.trainingpeaks.bridgeFolder': bridgeFolder,
      },
    });
    operation = crypto.randomUUID();
    message = 'Settings saved.';
  }

  const manage = $derived(path.startsWith('/manage'));

  const filtered = $derived(
    riders.filter(
      (r) =>
        `${r.player_id} ${r.username} ${r.first_name} ${r.last_name}`.toLowerCase().includes(search.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'no-password' && !r.has_password) ||
          (filter === 'administrator' && r.role === filter) ||
          (filter === 'enabled' && r.enabled === 1) ||
          (filter === 'disabled' && !r.enabled)),
    ),
  );

  async function api(url: string, method = 'GET', data?: ApiPayload) {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data !== undefined && { body: JSON.stringify(data) }),
    });

    const body = await response.json();

    if (body.csrf) csrf = body.csrf;

    if (!response.ok) {
      fieldErrors = body.fieldErrors ?? {};

      if (response.status === 409 && selected)
        conflictData = JSON.stringify(await api(`/api/manage/riders/${selected.player_id}`), null, 2);

      if (body.message === 'Password confirmation necessary.') confirmation = true;

      if (response.status === 401) {
        rider = null;
        navigate('/sign-in');
        await api('/api/setup');
      }

      throw new Error(body.message || 'Request failed.');
    }

    return body;
  }

  function navigate(next: string) {
    path = next;
    history.pushState({}, '', next);
    message = '';
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    message = '';
    fieldErrors = {};

    try {
      await work();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Request failed.';
    } finally {
      busy = false;
    }
  }

  async function loadRiders() {
    const body = await api('/api/manage/riders');
    riders = body.riders;
    confirmation = false;
  }

  async function signIn() {
    if (!complete && mode === 'new' && password !== confirmPassword) throw new Error('Passwords did not match.');

    const body = complete
      ? await api('/api/session', 'POST', { username, password })
      : await api('/api/setup', 'POST', {
          mode,
          key,
          username,
          password,
          ...(mode === 'new' && { first_name: first, last_name: last }),
        });

    rider = body.rider;
    password = '';
    key = '';
    const setup = !complete;
    complete = true;
    navigate(setup ? '/manage' : '/');

    if (setup) await loadRiders();
  }

  async function create() {
    await api('/api/manage/riders', 'POST', {
      operation,
      rider: { username, password, first_name: first, last_name: last },
    });
    operation = crypto.randomUUID();
    username = '';
    password = '';
    first = '';
    last = '';
    await loadRiders();
    message = 'Rider created.';
  }

  async function mutate(action: string) {
    if (!selected) return;

    if (!window.confirm('This action revokes sessions and can lose unsaved ride progress. Continue?')) return;

    const result = await api(`/api/manage/riders/${selected.player_id}/${action}`, action === 'role' ? 'PUT' : 'POST', {
      revision: selected.revision,
      operation,
      ...(action === 'password' && { password: targetPassword }),
      ...(action === 'role' && { role: selected.role === 'administrator' ? 'rider' : 'administrator' }),
    });

    operation = crypto.randomUUID();
    selected = result;
    targetPassword = '';
    await loadRiders();
    message =
      action === 'disable' && result.completion_deadline
        ? 'Disabled. The current ride can be saved for up to four hours. A server restart ends this permission.'
        : 'Saved.';
  }

  onMount(() => {
    const pop = () => {
      path = location.pathname;
    };

    window.addEventListener('popstate', pop);
    void run(async () => {
      const setup = await api('/api/setup');
      complete = setup.complete;

      if (!complete) navigate('/setup');
      else {
        try {
          const me = await api('/api/me');
          rider = me.rider;
        } catch {
          navigate('/sign-in');
        }

        if (rider && manage) await loadRiders();
      }
    }).finally(() => {
      loading = false;
    });

    return () => window.removeEventListener('popstate', pop);
  });
</script>

<div class:management={manage}>
  <Layout
    title={!rider ? (complete ? 'Sign in' : 'First administrator') : manage ? 'Manage' : 'My account'}
    page={manage ? 'manage' : 'account'}
    version="0.0.1"
  >
    {#if rider}<nav aria-label="Account">
        <button onclick={() => navigate('/')}>My account</button>{#if rider.role === 'administrator'}<button
            onclick={() =>
              run(async () => {
                navigate('/manage');
                await loadRiders();
              })}>Manage</button
          >{/if}<button
          onclick={() =>
            run(async () => {
              await api('/api/session', 'DELETE', {});
              await api('/api/setup');
              rider = null;
              navigate('/sign-in');
            })}>Sign out</button
        >
      </nav>{/if}
    {#if message}<p role="alert" class="notice">{message}</p>{/if}
    {#each Object.entries(fieldErrors) as [field, errors] (field)}<p class="notice" role="alert">
        {field}: {errors.join(' ')}
      </p>{/each}
    {#if conflictData}<section>
        <h2>Review the current server data</h2>
        <p>Your draft is kept. Review this data before you reload the rider.</p>
        <pre>{conflictData}</pre>
        <button
          onclick={() => {
            selected = JSON.parse(conflictData);
            conflictData = '';
          }}>Use current revision after review</button
        >
      </section>{/if}
    {#if loading}<p role="status">Loading…</p>
    {:else if !rider}
      {#if path === '/setup' && complete}<p>Setup is complete. Sign in to continue.</p>{/if}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void run(signIn);
        }}
      >
        {#if !complete}<label
            >Setup method<select bind:value={mode}
              ><option value="new">Create a new rider</option><option value="existing">Use an existing rider</option
              ></select
            ></label
          ><label
            >Setup key<input bind:value={key} autocomplete="off" required /><FieldErrors
              field="key"
              errors={fieldErrors}
            /></label
          >
          {#if mode === 'new'}<label
              >First name<input bind:value={first} maxlength="50" required /><FieldErrors
                field="first_name"
                errors={fieldErrors}
              /></label
            ><label
              >Last name<input bind:value={last} maxlength="50" /><FieldErrors
                field="last_name"
                errors={fieldErrors}
              /></label
            >{/if}{/if}
        <label
          >Login name<input bind:value={username} autocomplete="username" maxlength="254" required /><FieldErrors
            field="username"
            errors={fieldErrors}
          /></label
        >
        <label
          >Password<input
            type="password"
            bind:value={password}
            autocomplete={complete || mode === 'existing' ? 'current-password' : 'new-password'}
            maxlength="1024"
            required
          /><FieldErrors field="password" errors={fieldErrors} /></label
        >
        {#if !complete && mode === 'new'}<label
            >Confirm password<input
              type="password"
              bind:value={confirmPassword}
              autocomplete="new-password"
              required
            /><FieldErrors field="confirm_password" errors={fieldErrors} /></label
          >{/if}
        <button class="primary" disabled={busy}>{complete ? 'Sign in' : 'Complete setup'}</button>
      </form>
    {:else if manage}
      {#if rider.role !== 'administrator'}<p>Administrator role required.</p>
      {:else}
        {#if confirmation}
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/api/session/confirm', 'POST', { password: currentPassword });
                currentPassword = '';
                await loadRiders();
              });
            }}
          >
            <h2>Confirm your password</h2>
            <p>Management access expires 15 minutes after confirmation.</p>
            <label
              >Password<input
                type="password"
                bind:value={currentPassword}
                autocomplete="current-password"
                required
              /><FieldErrors field="current_password" errors={fieldErrors} /></label
            ><button disabled={busy}>Confirm</button>
          </form>
        {:else}
          {#if riders.some((r) => !r.has_password)}<p class="notice">
              {riders.filter((r) => !r.has_password).length} riders have no password and cannot sign in. Set a password for
              each rider.
            </p>{/if}
          <label>Search riders<input type="search" bind:value={search} /></label><label
            >Filter<select bind:value={filter}
              ><option value="all">All riders</option><option value="enabled">Enabled</option><option value="disabled"
                >Disabled</option
              ><option value="administrator">Administrators</option><option value="no-password">No password</option
              ></select
            ></label
          >
          <p>{filtered.length} riders</p>
          <div class="actions">
            <button disabled={page === 0} onclick={() => page--}>Previous</button><button
              disabled={(page + 1) * 25 >= filtered.length}
              onclick={() => page++}>Next</button
            >
          </div>
          <ul>
            {#each filtered.slice(page * 25, page * 25 + 25) as r (r.player_id)}<li>
                <button
                  onclick={() => {
                    selected = r;
                    editFirst = r.first_name;
                    editLast = r.last_name;
                    editLogin = r.username;
                    audit = '';
                    operation = crypto.randomUUID();
                  }}
                  >{r.player_id} · {r.first_name}
                  {r.last_name} · {r.username} · {r.role} · {r.enabled ? 'Enabled' : 'Disabled'} · {r.has_password
                    ? 'Password set'
                    : 'No password'}
                  {r.connected ? '· Connected' : ''}</button
                >
              </li>{/each}
          </ul>
          {#if selected}<section>
              <h2>{selected.first_name} {selected.last_name}</h2>
              {#if selected.completion_deadline}<p>
                  Ride completion deadline: {new Date(selected.completion_deadline).toLocaleString()}
                </p>{/if}
              <p>Revocation, password changes, and role changes can lose unsaved ride progress.</p>
              <form
                onsubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    selected = await api(`/api/manage/riders/${selected!.player_id}`, 'PATCH', {
                      revision: selected!.revision,
                      operation,
                      username: editLogin,
                      first_name: editFirst,
                      last_name: editLast,
                    });
                    operation = crypto.randomUUID();
                    await loadRiders();
                  });
                }}
              >
                <label
                  >First name<input bind:value={editFirst} required maxlength="50" /><FieldErrors
                    field="first_name"
                    errors={fieldErrors}
                  /></label
                ><label
                  >Last name<input bind:value={editLast} maxlength="50" /><FieldErrors
                    field="last_name"
                    errors={fieldErrors}
                  /></label
                ><label
                  >Login name<input bind:value={editLogin} required maxlength="254" /><FieldErrors
                    field="username"
                    errors={fieldErrors}
                  /></label
                ><button disabled={busy}>Save rider</button>
              </form>
              <button disabled={busy} onclick={() => run(() => openSettings(selected!.player_id))}
                >Rider settings</button
              >
              <div class="actions">
                <button disabled={busy} onclick={() => run(() => mutate(selected!.enabled ? 'disable' : 'enable'))}
                  >{selected.enabled ? 'Disable' : 'Enable'}</button
                ><button disabled={busy} onclick={() => run(() => mutate('role'))}
                  >{selected.role === 'administrator' ? 'Remove administrator role' : 'Give administrator role'}</button
                ><button disabled={busy} onclick={() => run(() => mutate('revoke-sessions'))}>Revoke sessions</button
                ><button
                  disabled={busy}
                  onclick={() =>
                    run(async () => {
                      audit = JSON.stringify(await api(`/api/manage/riders/${selected!.player_id}/audit`), null, 2);
                    })}>Change history</button
                >
              </div>
              {#if selected.player_id !== rider.player_id}<form
                  onsubmit={(e) => {
                    e.preventDefault();
                    void run(() => mutate('password'));
                  }}
                >
                  <label
                    >New password<input
                      type="password"
                      bind:value={targetPassword}
                      autocomplete="new-password"
                      required
                    /><FieldErrors field="password" errors={fieldErrors} /></label
                  ><button disabled={busy}>Set password</button>
                </form>{/if}
              {#if audit}<pre>{audit}</pre>{/if}
            </section>{/if}
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void run(create);
            }}
          >
            <h2>Create rider</h2>
            <label
              >First name<input bind:value={first} required maxlength="50" /><FieldErrors
                field="first_name"
                errors={fieldErrors}
              /></label
            ><label
              >Last name<input bind:value={last} maxlength="50" /><FieldErrors
                field="last_name"
                errors={fieldErrors}
              /></label
            ><label
              >Login name<input bind:value={username} autocomplete="off" required /><FieldErrors
                field="username"
                errors={fieldErrors}
              /></label
            ><label
              >Password<input type="password" bind:value={password} autocomplete="new-password" required /><FieldErrors
                field="password"
                errors={fieldErrors}
              /></label
            ><button class="primary" disabled={busy}>Create rider</button>
          </form>
          <section>
            <h2>Server</h2>
            <div class="actions">
              {#each ['restart', 'cancel-restart', 'reload-bots'] as action (action)}<button
                  disabled={busy}
                  onclick={() =>
                    run(async () => {
                      if (!window.confirm('Run this server operation?')) return;
                      const result = await api(`/api/manage/server/${action}`, 'POST', { operation });
                      operation = crypto.randomUUID();
                      message = `Operation ${result.status}.`;
                    })}>{action}</button
                >{/each}<button
                disabled={busy}
                onclick={() =>
                  run(async () => {
                    audit = JSON.stringify(await api('/api/manage/settings'), null, 2);
                  })}>Server configuration (read-only)</button
              >
            </div>
          </section>
        {/if}
      {/if}
    {:else}
      <button disabled={busy} onclick={() => run(() => openSettings(rider!.player_id))}>My settings</button>
      <p>{rider.first_name} {rider.last_name}</p>
      <p>{rider.username} · Player ID {rider.player_id}</p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (password !== confirmPassword) throw new Error('Passwords did not match.');
            await api('/api/me/password', 'POST', { current_password: currentPassword, password });
            await api('/api/setup');
            rider = null;
            currentPassword = '';
            password = '';
            confirmPassword = '';
            navigate('/sign-in');
          });
        }}
      >
        <h2>Change password</h2>
        <label
          >Current password<input
            type="password"
            bind:value={currentPassword}
            autocomplete="current-password"
            required
          /><FieldErrors field="current_password" errors={fieldErrors} /></label
        ><label
          >New password<input type="password" bind:value={password} autocomplete="new-password" required /><FieldErrors
            field="password"
            errors={fieldErrors}
          /></label
        ><label
          >Confirm password<input
            type="password"
            bind:value={confirmPassword}
            autocomplete="new-password"
            required
          /><FieldErrors field="confirm_password" errors={fieldErrors} /></label
        ><button disabled={busy}>Save</button>
      </form>
    {/if}
    {#if rider && manage && !confirmation && rider.role === 'administrator'}
      <section>
        <h2>Events</h2>
        <button
          disabled={busy}
          onclick={() =>
            run(async () => {
              events = (await api('/api/manage/events')).events;
            })}>Load events</button
        >
        {#each events as item (item.id)}<button
            onclick={() => {
              event = item;
              eventDescription = item.description;
              eventStart = item.eventStart;
              operation = crypto.randomUUID();
            }}>{item.name} · {item.eventStart}</button
          >{/each}
        {#if event}<form
            onsubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(`/api/manage/events/${event!.id}`, 'PATCH', {
                  operation,
                  revision: event!.updateDate,
                  changes: { description: eventDescription, eventStart },
                });
                operation = crypto.randomUUID();
                event = null;
                events = (await api('/api/manage/events')).events;
              });
            }}
          >
            <label>Description<input bind:value={eventDescription} /></label><label
              >Start time (UTC)<input bind:value={eventStart} required /></label
            ><button disabled={busy}>Save event</button><button
              type="button"
              disabled={busy}
              onclick={() =>
                run(async () => {
                  if (!window.confirm('Delete this event?')) return;
                  await api(`/api/manage/events/${event!.id}`, 'DELETE', { operation, revision: event!.updateDate });
                  operation = crypto.randomUUID();
                  event = null;
                  events = (await api('/api/manage/events')).events;
                })}>Delete event</button
            >
          </form>{/if}
      </section>
      <section>
        <h2>World settings</h2>
        <button
          disabled={busy}
          onclick={() =>
            run(async () => {
              worldSettings = (await api('/api/manage/settings')).worldSettings;
            })}>Load world settings</button
        >
        {#each worldSettings as item (item.id)}<button
            onclick={() => {
              worldSetting = item;
              worldValues = Object.fromEntries(item.fields.map((field) => [field.name, field.value]));
              operation = crypto.randomUUID();
            }}>{item.id}</button
          >{/each}
        {#if worldSetting}<form
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
                operation = crypto.randomUUID();
                message = 'Settings saved. Reload bots to apply world settings.';
              });
            }}
          >
            <p>Values use server defaults unless an override is stored. Reload bots after saving.</p>
            {#each worldSetting.fields as { name, kind, value } (name)}{#if kind === 'boolean'}<label
                  >{name}<input
                    type="checkbox"
                    checked={value === true}
                    onchange={(e) => {
                      worldValues[name] = e.currentTarget.checked;
                    }}
                  /></label
                >{:else if kind === 'number'}<label
                  >{name}<input
                    type="number"
                    step="any"
                    {value}
                    onchange={(e) => {
                      worldValues[name] = e.currentTarget.valueAsNumber;
                    }}
                  /></label
                >{:else}<label
                  >{name}<input
                    {value}
                    onchange={(e) => {
                      worldValues[name] = e.currentTarget.value;
                    }}
                  /></label
                >{/if}{/each}
            <button disabled={busy}>Save world settings</button>
          </form>{/if}
      </section>
    {/if}
    {#if rider && settings}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void run(saveSettings);
        }}
      >
        <h2>{manage ? 'Rider settings' : 'My settings'}</h2>
        <p>
          Values come from rider overrides when set; otherwise they use the server defaults. Changes apply on the next
          use.
        </p>
        <label><input type="checkbox" bind:checked={ghosts} /> Enable ghosts</label><label
          >Strava method<select bind:value={stravaMethod}
            ><option value="paid">API</option><option value="free">Session cookie</option></select
          ></label
        ><label>TrainingPeaks export folder<input bind:value={bridgeFolder} maxlength="500" /></label><button
          disabled={busy}>Save settings</button
        ><button
          type="button"
          onclick={() => {
            settings = null;
          }}>Close</button
        >
      </form>
    {/if}
  </Layout>
</div>

<style>
  nav,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-bottom: 1rem;
  }
  form,
  section {
    background: var(--glass);
    padding: 1.2rem;
    border: 1px solid var(--line);
    border-radius: 0.7rem;
    margin: 1rem 0;
  }
  label {
    display: block;
    margin: 0.8rem 0;
  }
  input,
  select {
    display: block;
    width: 100%;
    margin-top: 0.4rem;
  }
  li {
    list-style: none;
    margin: 0.5rem 0;
  }
  ul {
    padding: 0;
  }
  li button {
    text-align: left;
    width: 100%;
    overflow-wrap: anywhere;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .notice {
    color: var(--alarm);
  }
  .management :global(.bar) {
    border-bottom: 4px solid var(--orange);
  }
  .management :global(.wordmark)::after {
    content: ' / Manage';
    color: var(--orange);
  }
  button {
    cursor: pointer;
  }
  @media (max-width: 400px) {
    form,
    section {
      padding: 0.7rem;
    }
  }
</style>
