import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatImageIdSchema } from "@pi-web/contracts";

import { CodexImageStore } from "./images.js";

const THREAD = "019fa011-c136-7dc0-8c67-e5f7926bd517";
const OTHER_THREAD = "019fa2af-fc3c-7120-bbf5-9e970b2b7dd4";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function png(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  bytes[19] = 1;
  bytes[23] = 1;
  return bytes;
}

function input(data = png()) {
  return {
    text: "inspect",
    images: [
      {
        mimeType: "image/png" as const,
        data,
        digest: createHash("sha256").update(data).digest("hex"),
      },
    ],
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "codex-image-store-"));
  roots.push(home);
  return home;
}

describe("CodexImageStore", () => {
  it("uses private thread-scoped files and refuses cross-thread reads", async () => {
    const home = await temporaryHome();
    const store = new CodexImageStore(home);
    const source = input();
    const prepared = await store.prepare(THREAD, source);
    const image = prepared.images[0];
    if (image === undefined) throw new Error("Expected a stored image");
    expect((await stat(image.path)).mode & 0o077).toBe(0);
    await expect(store.read(THREAD, image.id)).resolves.toMatchObject({
      id: image.id,
      mimeType: "image/png",
    });
    await expect(store.read(OTHER_THREAD, image.id)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(store.referenceForPath(OTHER_THREAD, image.path)).toBeNull();
    expect(store.referenceForPath(THREAD, "/tmp/arbitrary.png")).toBeNull();
  });

  it("rejects content whose declared digest is false", async () => {
    const home = await temporaryHome();
    const store = new CodexImageStore(home);
    const source = input();
    const original = source.images[0];
    if (original === undefined) throw new Error("Expected an image input");
    source.images[0] = {
      ...original,
      digest: ChatImageIdSchema.parse("0".repeat(64)),
    };
    await expect(store.prepare(THREAD, source)).rejects.toMatchObject({
      code: "malformed",
      message: "chat_image_malformed",
    });
  });

  it("refuses a symlinked storage boundary", async () => {
    const home = await temporaryHome();
    const target = join(home, "outside");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(home, "pi-web-image-attachments"));
    await expect(
      new CodexImageStore(home).prepare(THREAD, input()),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});
