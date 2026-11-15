<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, children }: { title: string; children: Snippet } = $props();
</script>

<svelte:head><title>{title}</title></svelte:head>
<main>
  <h1 class="text-shadow">{title}</h1>
  {@render children()}
</main>

<style>
  :global(body) {
    font: 18px system-ui;
    max-width: 50rem;
    margin: 3rem auto;
    padding: 1rem;
    overflow: auto;
    min-height: calc(100vh - 8rem);
  }
  :global(a) {
    color: white;
    text-shadow: 1px 1px 2px black;
  }
  :global(button) {
    background: #b94000;
    color: white;
    border: 1px solid white;
    border-radius: 0.3rem;
    cursor: pointer;
  }
  :global(input),
  :global(button),
  :global(select) {
    font: inherit;
    padding: 0.5rem;
    margin: 0.4rem;
    max-width: 100%;
    box-sizing: border-box;
  }
  :global(label) {
    display: block;
  }
  :global(nav) {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  :global(:focus-visible) {
    outline: 3px solid #ffb365;
    outline-offset: 3px;
  }
  :global(button:disabled) {
    cursor: wait;
    opacity: 0.65;
  }
  :global(.error) {
    background: #3d0b0b;
    color: white;
    padding: 0.5rem;
  }
  :global([hidden]) {
    display: none !important;
  }
  @media (max-width: 500px) {
    :global(body) {
      margin: 0.5rem auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(*) {
      scroll-behavior: auto !important;
      animation: none !important;
      transition: none !important;
    }
  }
</style>
