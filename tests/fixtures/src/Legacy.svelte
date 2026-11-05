<script>
  export let items = [];
  export let size = undefined;
  let open = false;

  function add(item) {
    items.push(item);
    items = items;
  }

  $: total = items.length;
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div on:click on:click={() => (open = !open)}>{size} {total}</div>
{#each items as item}
  <button type="button" on:click={() => add(item)}>{item}</button>
{/each}
