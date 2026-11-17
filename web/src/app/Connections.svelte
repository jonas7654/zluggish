<script lang="ts">
  import { onMount } from 'svelte';
  import TextField from './TextField.svelte';

  let { api }: { api: <Body>(url: string, method?: string, data?: Record<string, string | boolean>) => Promise<Body> } =
    $props();

  type Provider = 'strava' | 'garmin' | 'intervals';

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
  let jobs = $state<UploadJob[]>([]);
  let confirmUnknown = $state(false);

  const providers: { name: Provider; title: string; username: string; secret: string }[] = [
    { name: 'strava', title: 'Strava API', username: 'Client ID', secret: 'Client secret' },
    { name: 'garmin', title: 'Garmin', username: 'Email', secret: 'Password' },
    { name: 'intervals', title: 'Intervals.icu', username: 'Athlete ID', secret: 'API key' },
  ];

  async function run(action: () => Promise<void>) {
    busy = true;
    message = '';
    failed = false;

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

  function save(name: Provider) {
    void run(async () => {
      await api(`/api/me/connections/${name}`, 'PUT', { username: connections![name].username, secret: secrets[name] });
      secrets[name] = '';
      message = 'Credentials saved.';
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
    });
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

        if (!authorizationCode) throw new Error('Strava authorization canceled.');
        await api('/api/me/connections/strava/authorize', 'POST', { code: authorizationCode, state });
        message = 'Strava authorized.';
      }
    });
  });
</script>

<section class="panel narrow">
  <h2>Connections</h2>
  <p class="muted">Manage activity uploads and planned workouts.</p>
  {#if message}<p role={failed ? 'alert' : 'status'}>{message}</p>{/if}
  {#if connections}
    {#each providers as provider (provider.name)}
      <h3>{provider.title}</h3>
      <p class="muted">
        {connections[provider.name].authorized
          ? 'Authorized'
          : connections[provider.name].saved
            ? 'Credentials saved'
            : 'Not connected'}
      </p>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          save(provider.name);
        }}
      >
        <TextField
          id={`${provider.name}-username`}
          label={provider.username}
          bind:value={connections[provider.name].username}
          required
          maxlength={500}
        />
        <TextField
          id={`${provider.name}-secret`}
          label={provider.secret}
          bind:value={secrets[provider.name]}
          password
          required={!connections[provider.name].saved}
          maxlength={10000}
          hint={connections[provider.name].saved ? 'Leave blank to keep the saved secret.' : undefined}
        />
        <button disabled={busy}>Save credentials</button>
      </form>
      {#if provider.name !== 'intervals'}
        {#if provider.name === 'strava'}<p class="muted">
            Set your Strava API application's callback domain to this website's hostname.
          </p>{/if}
        {#if provider.name === 'garmin' && mfa}<TextField
            id="garmin-code"
            label="Verification code"
            bind:value={code}
            maxlength={32}
          />{/if}
        <button disabled={busy || !connections[provider.name].saved} onclick={() => authorize(provider.name)}
          >{provider.name === 'garmin' && mfa ? 'Verify Garmin' : 'Authorize'}</button
        >
      {:else}
        <button disabled={busy || !connections.intervals.saved} onclick={() => sync('intervals')}>Sync workouts</button>
      {/if}
      <button
        disabled={busy ||
          !(
            connections[provider.name].saved ||
            connections[provider.name].authorized ||
            connections[provider.name].cookie
          )}
        onclick={() =>
          void run(async () => {
            await api(`/api/me/connections/${provider.name}`, 'DELETE');
            if (provider.name === 'garmin') {
              mfa = false;
              code = '';
            }
            message = 'Disconnected.';
          })}>Disconnect</button
      >
    {/each}
    <h3>Strava session cookie</h3>
    <p class="muted">
      {connections.strava.cookie ? 'Session cookie saved' : 'No session cookie saved'}. Used with the Session cookie
      upload method.
    </p>
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
      <TextField id="strava-cookie" label="_strava4_session" bind:value={cookie} password required maxlength={10000} />
      <button disabled={busy}>Save session cookie</button>
    </form>
    <button
      disabled={busy || !connections.strava.cookie}
      onclick={() =>
        void run(async () => {
          const { valid } = await api<{ valid: boolean }>('/api/me/connections/strava/test', 'POST', {});
          message = valid ? 'Session is valid.' : 'Session is not valid. Update the cookie.';
        })}>Test session</button
    >
    <h3>TrainingPeaks</h3>
    <p class="muted">Set the TrainingPeaks export folder above to import exported .zwo workouts.</p>
    <button disabled={busy} onclick={() => sync('trainingpeaks')}>Import workouts</button>
    <h3>Activity uploads</h3>
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
      <label
        ><input type="checkbox" bind:checked={confirmUnknown} /> I checked the provider and want to upload them again</label
      >
      <button disabled={busy || !confirmUnknown} onclick={() => retry(true)}
        >Retry uploads with an unknown result</button
      >
    {/if}
  {/if}
</section>
