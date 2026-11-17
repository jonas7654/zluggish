<script lang="ts">
  import { onMount } from 'svelte';
  import { connection, checkConnection, monitorConnection } from '../lib/connection';

  let interrupted = $state(false);
  $effect(() => {
    if ($connection.unavailable) interrupted = true;
  });
  onMount(monitorConnection);
</script>

{#if $connection.unavailable}
  <div class="connection" role="status">
    <div>
      <strong>Unable to connect to the server.</strong>
      <span
        >{$connection.checking ? 'Checking connection…' : `Retrying in ${$connection.retryIn}s.`} Your input is kept. Retry
        your action when connected.</span
      >
    </div>
    <button type="button" disabled={$connection.checking} onclick={() => void checkConnection()}>Retry now</button>
  </div>
{:else if interrupted}
  <div class="connection" role="status">
    <div>
      <strong>Connection restored.</strong><span
        >Retry your action, or reload to refresh this page. Reloading clears unsaved input.</span
      >
    </div>
    <button type="button" onclick={() => location.reload()}>Reload page</button>
    <button type="button" onclick={() => (interrupted = false)}>Dismiss</button>
  </div>
{/if}

<style>
  .connection {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 1rem;
    margin-bottom: 1rem;
    border-left: 3px solid var(--orange);
    border-radius: 10px;
    background: var(--glass);
  }
  strong,
  span {
    display: block;
  }
  span {
    margin-top: 0.3rem;
    color: var(--muted);
  }
  button {
    margin: 0;
  }
</style>
