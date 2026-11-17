<script lang="ts">
  import { onMount } from 'svelte';
  import { connection, checkConnection, monitorConnection } from '../lib/connection';

  onMount(monitorConnection);
</script>

{#if $connection.unavailable}
  <div class="connection" role="status">
    <div>
      <strong>Server connection lost...retrying in {$connection.retryIn}s</strong>
    </div>
    <button type="button" disabled={$connection.checking} onclick={() => void checkConnection()}>Retry now</button>
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
  strong {
    display: block;
  }
  button {
    margin: 0;
  }
</style>
