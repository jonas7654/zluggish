<script lang="ts">
  let { field, errors }: { field: string; errors: Record<string, string[]> } = $props();
</script>

{#each errors[field] ?? [] as error, index (`${field}-${index}`)}<span class="field-error" role="alert">{error}</span
  >{/each}
