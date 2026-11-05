<script>
  import { onDestroy } from "svelte";
  var count = 1;
  let unused = 2;
  let checked = false;
  onDestroy(() => {});
</script>

{#each [count] as n}
  <span>{n}</span>
{/each}
<img src="a.png" />
<button>{[count].forEach((c) => c)}</button>
<input type="checkbox" bind:value={checked} />
