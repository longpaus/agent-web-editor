import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  RuntimeFailure,
  type RuntimeImageContent,
  type RuntimeImageInput,
  type RuntimeUserInput,
} from "@pi-web/agent-runtime";
import {
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_SOURCE_BYTES,
  ChatImageIdSchema,
  ChatImageMimeTypeSchema,
  parseChatImageBytes,
  type ChatImageId,
  type ChatImageMimeType,
  type ChatImageRef,
} from "@pi-web/contracts";
import { z } from "zod";

const STORE_DIRECTORY = "pi-web-image-attachments";
const STORE_VERSION = "v1";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const THREAD_ID_SCHEMA = z.uuid();
const RUNTIME_INPUT_SCHEMA = z
  .object({
    text: z.string().max(200_000),
    images: z
      .array(
        z
          .object({
            mimeType: ChatImageMimeTypeSchema,
            data: z.instanceof(Uint8Array),
            digest: z.string().regex(DIGEST_PATTERN),
          })
          .strict(),
      )
      .max(CHAT_IMAGE_MAX_COUNT),
  })
  .strict();

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} satisfies Record<ChatImageMimeType, string>;
const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} satisfies Record<string, ChatImageMimeType>;
const EXTENSION_SCHEMA = z.enum(["jpg", "png", "webp"]);

export interface PreparedCodexImage {
  id: ChatImageId;
  mimeType: ChatImageMimeType;
  path: string;
  created: boolean;
}

export interface PreparedCodexInput {
  text: string;
  images: PreparedCodexImage[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function malformedImage(cause?: unknown): RuntimeFailure {
  return new RuntimeFailure("malformed", "chat_image_malformed", { cause });
}

function parseRuntimeInput(input: RuntimeUserInput | string): {
  text: string;
  images: RuntimeImageInput[];
} {
  if (typeof input === "string") return { text: input, images: [] };
  const parsed = RUNTIME_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) throw malformedImage(parsed.error);
  const images = parsed.data.images.map((image) => {
    if (
      image.data.byteLength === 0 ||
      image.data.byteLength > CHAT_IMAGE_MAX_SOURCE_BYTES
    )
      throw malformedImage();
    let detected: ReturnType<typeof parseChatImageBytes>;
    try {
      detected = parseChatImageBytes(image.data);
    } catch (error) {
      throw malformedImage(error);
    }
    if (
      detected.mimeType !== image.mimeType ||
      sha256(image.data) !== image.digest
    )
      throw malformedImage();
    return {
      mimeType: image.mimeType,
      data: Uint8Array.from(image.data),
      digest: image.digest,
    };
  });
  return { text: parsed.data.text, images };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const stats = await lstat(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0
  )
    throw new RuntimeFailure(
      "unauthorized",
      "Codex image storage is not a private directory.",
    );
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

/** Private, content-addressed image storage owned solely by this adapter. */
export class CodexImageStore {
  private readonly root: string;

  public constructor(codexHome: string) {
    this.root = join(resolve(codexHome), STORE_DIRECTORY, STORE_VERSION);
  }

  public async prepare(
    threadId: string,
    input: RuntimeUserInput | string,
  ): Promise<PreparedCodexInput> {
    const parsedThreadId = THREAD_ID_SCHEMA.safeParse(threadId);
    if (!parsedThreadId.success)
      throw new RuntimeFailure("malformed", "Invalid Codex thread id.");
    const parsed = parseRuntimeInput(input);
    if (parsed.images.length === 0) return { text: parsed.text, images: [] };
    const threadDirectory = await this.ensureThreadDirectory(
      parsedThreadId.data,
    );
    const images: PreparedCodexImage[] = [];
    try {
      for (const image of parsed.images) {
        const id = ChatImageIdSchema.parse(image.digest);
        const path = join(
          threadDirectory,
          `${id}.${EXTENSION_BY_MIME[image.mimeType]}`,
        );
        const created = await this.writeOrVerify(
          path,
          image.data,
          id,
          image.mimeType,
        );
        images.push({ id, mimeType: image.mimeType, path, created });
      }
    } catch (error) {
      await this.discardCreated({ text: parsed.text, images });
      throw error;
    }
    return { text: parsed.text, images };
  }

  /** Removes only files introduced by a definitively rejected dispatch. */
  public async discardCreated(input: PreparedCodexInput): Promise<void> {
    await Promise.all(
      input.images.flatMap((image) =>
        image.created ? [unlink(image.path).catch(() => undefined)] : [],
      ),
    );
  }

  public referenceForPath(
    threadId: string,
    rawPath: string,
  ): ChatImageRef | null {
    if (!THREAD_ID_SCHEMA.safeParse(threadId).success || !isAbsolute(rawPath))
      return null;
    const expectedDirectory = this.threadDirectory(threadId);
    if (dirname(rawPath) !== expectedDirectory || resolve(rawPath) !== rawPath)
      return null;
    const match = /^([0-9a-f]{64})\.(jpg|png|webp)$/.exec(basename(rawPath));
    if (match === null) return null;
    const id = ChatImageIdSchema.safeParse(match[1]);
    const extension = EXTENSION_SCHEMA.safeParse(match[2]);
    const mimeType = ChatImageMimeTypeSchema.safeParse(
      extension.success ? MIME_BY_EXTENSION[extension.data] : undefined,
    );
    return id.success && mimeType.success
      ? { id: id.data, mimeType: mimeType.data }
      : null;
  }

  public async read(
    threadId: string,
    imageId: ChatImageId,
  ): Promise<RuntimeImageContent> {
    const parsedThreadId = THREAD_ID_SCHEMA.safeParse(threadId);
    const parsedImageId = ChatImageIdSchema.safeParse(imageId);
    if (!parsedThreadId.success || !parsedImageId.success)
      throw new RuntimeFailure("unauthorized", "Image attachment not found.");
    await this.ensureThreadDirectory(parsedThreadId.data);
    for (const [extension, mimeType] of Object.entries(MIME_BY_EXTENSION)) {
      const path = join(
        this.threadDirectory(parsedThreadId.data),
        `${parsedImageId.data}.${extension}`,
      );
      try {
        const data = await this.readVerified(
          path,
          parsedImageId.data,
          mimeType,
        );
        return {
          id: parsedImageId.data,
          mimeType,
          data: Buffer.from(data).toString("base64"),
        };
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
    }
    throw new RuntimeFailure("unauthorized", "Image attachment not found.");
  }

  private threadDirectory(threadId: string): string {
    return join(this.root, threadId);
  }

  private async ensureThreadDirectory(threadId: string): Promise<string> {
    const storeDirectory = dirname(this.root);
    await ensurePrivateDirectory(storeDirectory);
    await ensurePrivateDirectory(this.root);
    const threadDirectory = this.threadDirectory(threadId);
    await ensurePrivateDirectory(threadDirectory);
    return threadDirectory;
  }

  private async writeOrVerify(
    path: string,
    data: Uint8Array,
    id: ChatImageId,
    mimeType: ChatImageMimeType,
  ): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          noFollowFlag(),
        0o600,
      );
      created = true;
      await handle.writeFile(data);
      await handle.sync();
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        await this.readVerified(path, id, mimeType);
        return false;
      }
      if (created) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        await unlink(path).catch(() => undefined);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async readVerified(
    path: string,
    id: ChatImageId,
    expectedMimeType: ChatImageMimeType,
  ): Promise<Uint8Array> {
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        (stats.mode & 0o077) !== 0 ||
        stats.size === 0 ||
        stats.size > CHAT_IMAGE_MAX_SOURCE_BYTES
      )
        throw malformedImage();
      const data = await handle.readFile();
      let detected: ReturnType<typeof parseChatImageBytes>;
      try {
        detected = parseChatImageBytes(data);
      } catch (error) {
        throw malformedImage(error);
      }
      if (detected.mimeType !== expectedMimeType || sha256(data) !== id)
        throw malformedImage();
      return data;
    } finally {
      await handle.close();
    }
  }
}
