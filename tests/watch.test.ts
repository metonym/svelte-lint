import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "../src/api.ts";
import type { WatchUpdate } from "../src/types.ts";
import { brief, workspace } from "./shared.ts";

/** The updates a watch sends, and a way to wait for the next one that matches. */
function recorder() {
  const updates: WatchUpdate[] = [];
  const waiting: [(u: WatchUpdate) => boolean, (u: WatchUpdate) => void][] = [];
  const onUpdate = (update: WatchUpdate) => {
    updates.push(update);
    for (const [index, [match, resolve]] of waiting.entries()) {
      if (!match(update)) continue;
      waiting.splice(index, 1);
      resolve(update);
      break;
    }
  };
  const next = (match: (u: WatchUpdate) => boolean) =>
    new Promise<WatchUpdate>((resolve) => waiting.push([match, resolve]));
  return { updates, onUpdate, next };
}

describe("watch", () => {
  it("lints a component again when it changes, template problems first, and drops a removed one", async () => {
    const dir = await workspace("watch");
    const { onUpdate, next } = recorder();
    const watcher = await watch({ cwd: dir, cache: false, onUpdate });
    try {
      const file = join(dir, "src/Added.svelte");
      const template = next((u) => u.stage === "template");
      const done = next((u) => u.stage === "done" && u.reason === "change");
      await writeFile(
        file,
        "<script>\n  var a = 1;\n</script>\n<img src={a} />\n",
      );
      expect((await template).diagnostics.map(brief)).toContain(
        "src/Added.svelte:4 svelte/a11y_missing_attribute",
      );
      const after = (await done).diagnostics
        .map(brief)
        .filter((d) => d.startsWith("src/Added"));
      expect(after).toEqual([
        "src/Added.svelte:2 no-var",
        "src/Added.svelte:4 svelte/a11y_missing_attribute",
      ]);

      const removed = next((u) => u.stage === "removed");
      await rm(file);
      const update = await removed;
      expect(update.changed).toEqual(["src/Added.svelte"]);
      expect(
        update.diagnostics.some((d) => d.file === "src/Added.svelte"),
      ).toBe(false);
    } finally {
      watcher.close();
    }
  });
});
