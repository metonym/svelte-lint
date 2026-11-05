<script lang="ts">
  let { items = [], label }: { items?: string[]; label: string } = $props();
  let count = $state(0);
  const doubled = $derived(count * 2);
</script>

<button type="button" onclick={() => count++}>{label}: {doubled}</button>
{#each items as item (item)}
  <span>{item}</span>
{/each}
