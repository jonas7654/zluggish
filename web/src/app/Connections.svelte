<script lang="ts">
  import { onMount } from 'svelte';
  import TextField from './TextField.svelte';

  let {
    api,
    stravaMethod = $bindable(),
    bridgeFolder = $bindable(),
    saved,
    save,
  }: {
    api: <Body>(url: string, method?: string, data?: Record<string, string | boolean>) => Promise<Body>;
    stravaMethod: string;
    bridgeFolder: string;
    /** The settings the server holds, so a tile does not change before its choice is saved. */
    saved: { stravaMethod: string; bridgeFolder: string };
    save: () => Promise<void>;
  } = $props();

  type Provider = 'strava' | 'garmin' | 'intervals';

  type Integration = Provider | 'trainingpeaks';

  type Connection = { username: string; saved: boolean; authorized?: boolean; cookie?: boolean };

  type UploadJob = { activity_id: number; provider: string; state: string };

  let connections = $state<Record<Provider, Connection> | null>(null);
  let secrets = $state<Record<Provider, string>>({ strava: '', garmin: '', intervals: '' });
  let cookie = $state('');
  let code = $state('');
  let mfa = $state(false);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);
  let where = $state<'integration' | 'uploads'>('integration');
  let jobs = $state<UploadJob[]>([]);
  let confirmUnknown = $state(false);
  let open = $state<Integration | null>(null);

  const integrations: { name: Integration; title: string }[] = [
    { name: 'strava', title: 'Strava' },
    { name: 'garmin', title: 'Garmin' },
    { name: 'intervals', title: 'Intervals.icu' },
    { name: 'trainingpeaks', title: 'TrainingPeaks' },
  ];

  const fields: Record<Provider, { username: string; secret: string }> = {
    strava: { username: 'Client ID', secret: 'Client secret' },
    garmin: { username: 'Email', secret: 'Password' },
    intervals: { username: 'Athlete ID', secret: 'API key' },
  };

  /** Connected means finished rides (or workouts) actually flow, not just that something was typed in. */
  function status(name: Integration, all: Record<Provider, Connection>) {
    if (name === 'trainingpeaks') {
      return saved.bridgeFolder ? { connected: true, text: 'Folder set' } : { connected: false, text: 'No folder set' };
    }

    const connection = all[name];

    const connected =
      name === 'strava'
        ? saved.stravaMethod === 'paid'
          ? Boolean(connection.authorized)
          : Boolean(connection.cookie)
        : name === 'garmin'
          ? Boolean(connection.authorized)
          : connection.saved;

    return {
      connected,
      text: connected ? 'Connected' : connection.saved ? 'Credentials saved' : 'Not connected',
    };
  }

  async function run(action: () => Promise<void>, scope: 'integration' | 'uploads' = 'integration') {
    busy = true;
    message = '';
    failed = false;
    where = scope;

    try {
      await action();
      connections = await api<Record<Provider, Connection>>('/api/me/connections');
      jobs = (await api<{ jobs: UploadJob[] }>('/api/me/uploads')).jobs;
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : 'Could not save connection.';
    } finally {
      busy = false;
    }
  }

  function choose(name: Integration) {
    open = open === name ? null : name;
    message = '';
  }

  function saveCredentials(name: Provider) {
    void run(async () => {
      await api(`/api/me/connections/${name}`, 'PUT', { username: connections![name].username, secret: secrets[name] });
      secrets[name] = '';
      message = 'Credentials saved.';
    });
  }

  function saveMethod() {
    void run(async () => {
      try {
        await save();
      } catch (error) {
        stravaMethod = saved.stravaMethod;
        throw error;
      }

      message = 'Upload method saved.';
    });
  }

  function authorize(name: Provider) {
    void run(async () => {
      const result = await api<{ url?: string; status?: string }>(
        `/api/me/connections/${name}/authorize`,
        'POST',
        name === 'garmin' && mfa ? { code } : {},
      );

      if (result.url) {
        window.location.assign(result.url);

        return;
      }

      mfa = result.status === 'mfa';
      code = '';
      message = mfa ? 'Enter the verification code from Garmin.' : 'Authorized.';
    });
  }

  function disconnect(name: Provider) {
    void run(async () => {
      await api(`/api/me/connections/${name}`, 'DELETE');

      if (name === 'garmin') {
        mfa = false;
        code = '';
      }

      message = 'Disconnected.';
    });
  }

  function sync(provider: 'intervals' | 'trainingpeaks') {
    void run(async () => {
      message = (await api<{ message: string }>('/api/me/workouts/sync', 'POST', { provider })).message;
    });
  }

  function retry(ambiguous: boolean) {
    void run(async () => {
      await api('/api/me/uploads/retry', 'POST', { ambiguous });
      confirmUnknown = false;
      message = 'Retry requested. Check the provider before retrying again.';
    }, 'uploads');
  }

  // Deliveries finish in the background, so the list refreshes while any is still in flight.
  $effect(() => {
    if (!jobs.some((job) => ['pending', 'sending'].includes(job.state))) return;

    const timer = setInterval(() => {
      if (document.hidden) return;
      api<{ jobs: UploadJob[] }>('/api/me/uploads').then(
        (body) => (jobs = body.jobs),
        () => {
          /* The next tick tries again. */
        },
      );
    }, 5000);

    return () => clearInterval(timer);
  });

  onMount(() => {
    void run(async () => {
      const query = new URLSearchParams(window.location.search);

      if (query.has('state')) {
        const authorizationCode = query.get('code');
        const state = query.get('state') ?? '';
        history.replaceState(null, '', '/settings');
        open = 'strava';

        if (!authorizationCode) throw new Error('Strava authorization canceled.');
        await api('/api/me/connections/strava/authorize', 'POST', { code: authorizationCode, state });
        message = 'Strava authorized.';
      }
    });
  });
</script>

{#snippet credentials(name: Provider)}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      saveCredentials(name);
    }}
  >
    <TextField
      id={`${name}-username`}
      label={fields[name].username}
      bind:value={connections![name].username}
      required
      maxlength={500}
    />
    <TextField
      id={`${name}-secret`}
      label={fields[name].secret}
      bind:value={secrets[name]}
      password
      required={!connections![name].saved}
      maxlength={10000}
      hint={connections![name].saved ? 'Leave blank to keep the saved secret.' : undefined}
    />
    <button disabled={busy}>Save credentials</button>
  </form>
{/snippet}

{#snippet disconnectButton(name: Provider)}
  <button
    class="quiet"
    disabled={busy || !(connections![name].saved || connections![name].authorized || connections![name].cookie)}
    onclick={() => disconnect(name)}>Disconnect</button
  >
{/snippet}

<section class="integrations" aria-labelledby="integrations-title">
  <h2 id="integrations-title">Integrations</h2>
  <p class="lead">Send finished rides to the apps you train with, and bring planned workouts into Zwift.</p>
  {#if message && where === 'integration' && !open}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>
      {message}
    </p>{/if}
  {#if connections}
    <div class="tiles">
      {#each integrations as integration (integration.name)}
        {@const current = status(integration.name, connections)}
        <button
          type="button"
          class="tile"
          aria-expanded={open === integration.name}
          aria-controls="integration-detail"
          onclick={() => choose(integration.name)}
        >
          <span class="box" class:on={current.connected} aria-hidden="true">
            {#if current.connected}<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>{/if}
          </span>
          <span class="name">{integration.title}</span>
          <span class="state">{current.text}</span>
        </button>
      {/each}
    </div>

    {#if open}
      <div class="detail" id="integration-detail" role="region" aria-labelledby="integration-title">
        <h3 id="integration-title">{integrations.find((item) => item.name === open)!.title}</h3>
        {#if message && where === 'integration'}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>
            {message}
          </p>{/if}

        {#if open === 'strava'}
          <p class="muted">Upload finished rides to Strava, through your own API application or a browser session.</p>
          <label for="strava-method">Upload method</label>
          <select id="strava-method" bind:value={stravaMethod} disabled={busy} onchange={saveMethod}>
            <option value="paid">Strava API application</option>
            <option value="free">Browser session cookie</option>
          </select>
          {#if stravaMethod === 'paid'}
            {@render credentials('strava')}
            <p class="muted">Set your Strava API application's callback domain to this website's hostname.</p>
            <div class="actions">
              <button disabled={busy || !connections.strava.saved} onclick={() => authorize('strava')}>Authorize</button
              >
              {@render disconnectButton('strava')}
            </div>
          {:else}
            <form
              onsubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api('/api/me/connections/strava/cookie', 'PUT', { cookie });
                  cookie = '';
                  message = 'Session cookie saved.';
                });
              }}
            >
              <TextField
                id="strava-cookie"
                label="_strava4_session"
                bind:value={cookie}
                password
                required
                maxlength={10000}
                hint={connections.strava.cookie
                  ? 'A session cookie is saved. Paste a new one to replace it.'
                  : 'Copy it from your browser while signed in to Strava. Treat it like a password.'}
              />
              <button disabled={busy}>Save session cookie</button>
            </form>
            <div class="actions">
              <button
                disabled={busy || !connections.strava.cookie}
                onclick={() =>
                  void run(async () => {
                    const { valid } = await api<{ valid: boolean }>('/api/me/connections/strava/test', 'POST', {});
                    message = valid ? 'Session is valid.' : 'Session is not valid. Update the cookie.';
                  })}>Test session</button
              >
              {@render disconnectButton('strava')}
            </div>
          {/if}
        {:else if open === 'garmin'}
          <p class="muted">Upload finished rides to Garmin Connect.</p>
          {@render credentials('garmin')}
          {#if mfa}<TextField id="garmin-code" label="Verification code" bind:value={code} maxlength={32} />{/if}
          <div class="actions">
            <button disabled={busy || !connections.garmin.saved} onclick={() => authorize('garmin')}
              >{mfa ? 'Verify Garmin' : 'Authorize'}</button
            >
            {@render disconnectButton('garmin')}
          </div>
        {:else if open === 'intervals'}
          <p class="muted">
            Upload finished rides and bring your planned cycling workouts into Zwift. Find the athlete ID and API key
            under Developer Settings on Intervals.icu.
          </p>
          {@render credentials('intervals')}
          <div class="actions">
            <button disabled={busy || !connections.intervals.saved} onclick={() => sync('intervals')}
              >Sync workouts</button
            >
            {@render disconnectButton('intervals')}
          </div>
        {:else}
          <p class="muted">
            Import workouts you export from TrainingPeaks as .zwo files. The server reads them from this folder.
          </p>
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await save();
                message = 'Export folder saved.';
              });
            }}
          >
            <TextField id="bridge-folder" label="Export folder" bind:value={bridgeFolder} maxlength={500} />
            <button disabled={busy}>Save folder</button>
          </form>
          <div class="actions">
            <button disabled={busy || !saved.bridgeFolder} onclick={() => sync('trainingpeaks')}>Import workouts</button
            >
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</section>

{#if connections}
  <section class="detail uploads" aria-labelledby="uploads-title">
    <h2 id="uploads-title">Activity uploads</h2>
    {#if message && where === 'uploads'}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>
        {message}
      </p>{/if}
    {#if jobs.length}
      <ul>
        {#each jobs as job (`${job.activity_id}-${job.provider}`)}<li>
            Activity {job.activity_id}: {job.provider} — {job.state}
          </li>{/each}
      </ul>
    {:else}
      <p class="muted">No activity uploads yet.</p>
    {/if}
    <button disabled={busy || !jobs.some((job) => job.state === 'failed')} onclick={() => retry(false)}
      >Retry failed uploads</button
    >
    {#if jobs.some((job) => job.state === 'ambiguous')}
      <p class="muted">The provider may already have activities whose upload result is unknown.</p>
      <label class="check"
        ><input type="checkbox" bind:checked={confirmUnknown} /> I checked the provider and want to upload them again</label
      >
      <button disabled={busy || !confirmUnknown} onclick={() => retry(true)}
        >Retry uploads with an unknown result</button
      >
    {/if}
  </section>
{/if}

<style>
  /* Panels match the settings panel above: 34rem of content plus padding. */
  .detail {
    max-width: 34rem;
  }
  .integrations {
    max-width: 36.5rem;
    margin: 2rem 0 1rem;
  }
  .lead {
    margin: 0 0 1rem;
  }

  /* Laid out like the game's pairing screen: one tile per service, ticked once it is live. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.5rem;
  }
  button.tile {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.65rem;
    align-items: center;
    margin: 0;
    padding: 0.8rem 0.9rem;
    border: 2px solid var(--line);
    border-radius: 10px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    text-align: left;
    text-transform: none;
    letter-spacing: 0;
  }
  button.tile:hover {
    border-color: rgb(255 255 255 / 0.45);
    background: var(--glass-raised);
  }
  button.tile[aria-expanded='true'] {
    border-color: var(--orange);
    background: var(--glass-raised);
  }
  .box {
    grid-row: span 2;
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    box-sizing: border-box;
    border: 2px solid rgb(255 255 255 / 0.55);
    border-radius: 4px;
  }
  .box.on {
    border-color: var(--orange);
    background: var(--orange);
  }
  .box svg {
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: var(--text);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .name {
    font-size: 0.9375rem;
    font-weight: 800;
  }
  .state {
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .detail {
    margin: 0.75rem 0 1rem;
    padding: 1.25rem;
    border-radius: 12px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .detail h3 {
    margin: 0 0 0.25rem;
    font-size: 1.125rem;
    font-weight: 800;
  }
  /* Forms sit inside the panel, so they drop their own glass. */
  .detail form {
    margin: 0;
    padding: 0;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    margin-top: 0.75rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--line);
  }
  .actions button {
    margin-right: 0;
  }
  button.quiet {
    border-color: var(--line);
    color: var(--muted);
  }
  .uploads {
    margin-top: 2rem;
  }
  .uploads ul {
    padding-left: 1.1rem;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text);
  }
  .muted {
    color: var(--muted);
  }
  .notice.failed {
    color: var(--alarm);
  }

  @media (max-width: 500px) {
    .detail {
      padding: 0.9rem;
    }
  }
</style>
