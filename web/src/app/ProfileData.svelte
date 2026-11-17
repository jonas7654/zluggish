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

  let recreate = $state(false);
  let confirm = $state(false);
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
    if (path === '/import' || path === '/power-curves') return;
    if (path === '/export') {
      void run(async () => {
        filenames = (await request<{ filenames: string[] }>('/api/me/export')).filenames;
      });
      return;
    }

    void run(async () => {
      const body = await request<{ filenames: string[]; review: Review | null }>('/api/me/import');
      filenames = body.filenames;
      review = body.review;
      connection = await request('/api/me/zwift');
    });
  });
</script>

{#if path === '/export'}
  <section class="panel">
    <p>Download your rider data.</p>
    {#each filenames as filename (filename)}
      <p><a href={`/api/me/export/${encodeURIComponent(filename)}`} download={filename}>Download {filename}</a></p>
    {:else}
      <p>No files available to export.</p>
    {/each}
  </section>
{:else if path === '/power-curves'}
  <form
    class="panel"
    onsubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        const result = await request<{ message: string }>('/api/me/power-curves', 'POST', {
          confirm,
          create: recreate,
        });
        confirm = false;
        message = result.message;
      });
    }}
  >
    <label><input type="checkbox" bind:checked={recreate} disabled={busy} /> Recreate from saved activities</label>
    <label
      ><input type="checkbox" bind:checked={confirm} required disabled={busy} /> I confirm: Delete existing power curves?
      Rebuilding may take some time.</label
    >
    <button disabled={busy || !confirm}>Delete existing power curves</button>
  </form>
{:else if path === '/import'}
  <p>Choose how to import your profile data.</p>
  <nav class="import-options" aria-label="Import source">
    <a
      href="/import/local"
      onclick={(e) => {
        e.preventDefault();
        void navigate('/import/local');
      }}
    >
      <span class="option-title">Local files</span>
      <span class="option-description">Upload rider data from files on your computer.</span>
    </a>
    <a
      href="/zwift"
      onclick={(e) => {
        e.preventDefault();
        void navigate('/zwift');
      }}
    >
      <span class="option-title">Zwift connection</span>
      <span class="option-description">Connect to Zwift and download your rider data.</span>
    </a>
  </nav>
{:else if path === '/import/local' || path === '/zwift'}
  <nav aria-label="Profile data">
    <a
      href="/import"
      onclick={(e) => {
        e.preventDefault();
        void navigate('/import');
      }}>← Import options</a
    >
  </nav>
{/if}
{#if message}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>{message}</p>{/if}
{#if path !== '/import' && path !== '/export' && path !== '/power-curves' && review}
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
{:else if path === '/import/local'}
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
{:else if path === '/zwift' && connection}
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
  .import-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 1rem;
    max-width: 50rem;
    margin-top: 1.5rem;
  }
  .import-options a {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.75rem;
    min-height: 10rem;
    box-sizing: border-box;
    padding: 1.75rem;
    border: 2px solid var(--line);
    border-radius: 12px;
    background: var(--glass);
    text-decoration: none;
  }
  .import-options a:hover,
  .import-options a:focus-visible {
    border-color: var(--orange);
    background: var(--glass-raised);
  }
  .option-title {
    font-size: 1.25rem;
  }
  .option-description {
    color: var(--muted);
    font-weight: 600;
    font-size: 0.9375rem;
    text-transform: none;
    letter-spacing: normal;
  }

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
