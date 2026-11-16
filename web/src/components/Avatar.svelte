<script lang="ts">
  let { initials, photo = null }: { initials: string; photo?: string | null | undefined } = $props();
</script>

<span class="avatar"
  >{#if photo}<img src={photo} alt="" />{:else}{initials}{/if}</span
>
