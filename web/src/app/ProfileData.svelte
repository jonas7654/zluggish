<script lang="ts">
  import { onMount } from 'svelte';

  type Review = {
    stage: string;
    firstName: string;
    lastName: string;
    sourceId: string | null;
    files: string[];
    confirmSource: boolean;
  };

  type Connection = { connected: boolean; upload: boolean; click: boolean };

  let {
    path,
    request,
    navigate,
    onrider,
  }: {
    path: string;
    request: <Body>(url: string, method?: string, data?: Record<string, string | boolean> | FormData) => Promise<Body>;
    navigate: (path: string) => Promise<void>;
    onrider: () => Promise<void>;
  } = $props();

  let filenames = $state<string[]>([]);
  let review = $state<Review | null>(null);
  let connection = $state<Connection | null>(null);
  let username = $state('');
  let password = $state('');
  let profile = $state(false);
  let achievements = $state(false);
  let keepName = $state(false);
  let confirmSource = $state(false);
  let removing = $state(false);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    message = '';
    failed = false;

    try {
      await work();
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : 'Request failed.';
    } finally {
      busy = false;
    }
  }

  function staged(body: { review: Review }) {
    review = body.review;
    keepName = false;
    confirmSource = false;
  }

  onMount(() => {
    void run(async () => {
      const body = await request<{ filenames: string[]; review: Review | null }>('/api/me/import');
      filenames = body.filenames;
      review = body.review;
      connection = await request('/api/me/zwift');
    });
  });
</script>

<nav aria-label="Profile data">
  <a
    href="/import"
    onclick={(e) => {
      e.preventDefault();
      void navigate('/import');
    }}>Import local files</a
  >
  <a
    href="/zwift"
    onclick={(e) => {
      e.preventDefault();
      void navigate('/zwift');
    }}>Zwift connection</a
  >
</nav>
{#if message}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>{message}</p>{/if}
{#if review}
  <form
    class="panel"
    onsubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        await request('/api/me/import/confirm', 'POST', { stage: review!.stage, keepName, confirmSource });
        review = null;
        await onrider();
        message = 'Profile data imported.';
      });
    }}
  >
    <h2>Confirm profile import</h2>
    <p>{review.firstName} {review.lastName} ({review.sourceId ?? 'unknown source'})</p>
    <p>Replace: {review.files.join(', ')}</p>
    {#if review.confirmSource}<label
        ><input type="checkbox" bind:checked={confirmSource} required /> Confirm this source may differ or be shared with
        another rider</label
      >{/if}
    <label><input type="checkbox" bind:checked={keepName} /> Keep local name</label>
    <button class="primary" disabled={busy}>Confirm import</button>
    <button
      type="button"
      disabled={busy}
      onclick={() =>
        run(async () => {
          await request('/api/me/import/confirm', 'POST', { stage: review!.stage, cancel: true });
          review = null;
          message = 'Import canceled. Your rider data is unchanged.';
        })}>Cancel</button
    >
  </form>
{:else if path === '/import'}
  <p>Your local rider ID and password remain unchanged.</p>
  <form
    class="panel"
    enctype="multipart/form-data"
    onsubmit={(e) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      void run(async () => staged(await request('/api/me/import', 'POST', data)));
    }}
  >
    {#each filenames as filename (filename)}
      <label for={filename}>{filename}</label>
      <input id={filename} name={filename} type="file" disabled={busy} />
    {/each}
    <button class="primary" disabled={busy || !filenames.length}>Review import</button>
  </form>
{:else if connection}
  <p>
    {connection.connected
      ? 'Credentials saved. Leave username and password blank to keep them.'
      : 'Save your official Zwift credentials to connect.'}
  </p>
  <form
    class="panel"
    onsubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        connection = await request('/api/me/zwift', 'PUT', {
          username,
          password,
          upload: connection!.upload,
          click: connection!.click,
        });
        username = '';
        password = '';
        message = 'Connection settings saved.';
      });
    }}
  >
    <label for="zwift-username">Username</label>
    <input id="zwift-username" autocomplete="username" bind:value={username} disabled={busy} />
    <label for="zwift-password">Password</label>
    <input id="zwift-password" type="password" autocomplete="new-password" bind:value={password} disabled={busy} />
    <label><input type="checkbox" bind:checked={connection.upload} /> Upload activities to Zwift</label>
    <label><input type="checkbox" bind:checked={connection.click} /> Enable Zwift Click authentication</label>
    <button class="primary" disabled={busy}>Save connection</button>
  </form>
  {#if connection.connected}
    <form
      class="panel"
      onsubmit={(e) => {
        e.preventDefault();
        void run(async () => staged(await request('/api/me/zwift/import', 'POST', { profile, achievements })));
      }}
    >
      <h2>Download rider data</h2>
      <label><input type="checkbox" bind:checked={profile} /> Download profile and economy</label>
      <label><input type="checkbox" bind:checked={achievements} /> Download achievements</label>
      <button class="primary" disabled={busy || (!profile && !achievements)}>Download and review import</button>
    </form>
    <section class="panel">
      {#if removing}
        <p>Remove Zwift credentials?</p>
        <button
          disabled={busy}
          onclick={() =>
            run(async () => {
              connection = await request('/api/me/zwift', 'DELETE', {});
              removing = false;
              message = 'Credentials removed.';
            })}>Remove credentials</button
        >
        <button disabled={busy} onclick={() => (removing = false)}>Cancel</button>
      {:else}<button disabled={busy} onclick={() => (removing = true)}>Remove credentials</button>{/if}
    </section>
  {/if}
{/if}

<style>
  .panel {
    max-width: 38rem;
    padding: 1.25rem;
    margin: 1rem 0;
    border-radius: 12px;
    background: var(--glass);
  }
  input[type='checkbox'] {
    width: auto;
    margin-right: 0.5rem;
  }
  input[type='file'] {
    width: 100%;
  }
  .failed {
    color: var(--alarm);
  }
</style>
