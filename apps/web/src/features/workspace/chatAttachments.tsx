import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import {
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_SOURCE_BYTES,
  type ImageInputCapability,
} from "@pi-web/contracts";

const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const supportedExtension = /\.(?:jpe?g|png|webp)$/i;

export interface PendingChatImage {
  id: string;
  file: File;
  label: string;
  previewUrl: string;
}

function objectUrl(file: File): string {
  return typeof URL.createObjectURL === "function"
    ? URL.createObjectURL(file)
    : "";
}

function revoke(url: string): void {
  if (url !== "" && typeof URL.revokeObjectURL === "function")
    URL.revokeObjectURL(url);
}

function fileLabel(file: File, source: "drop" | "picker" | "paste", n: number) {
  if (source !== "paste" && file.name.trim() !== "") return file.name;
  if (
    source === "paste" &&
    file.name.trim() !== "" &&
    !/^image\.(?:jpe?g|png|webp)$/i.test(file.name)
  )
    return file.name;
  return `Pasted image ${String(n)}`;
}

export function useChatAttachments(
  capability: ImageInputCapability,
  onDropClaimed?: () => void,
) {
  const [images, setImages] = useState<PendingChatImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const addFiles = useCallback(
    (files: readonly File[], source: "drop" | "picker" | "paste") => {
      if (capability === "unsupported") {
        return;
      }
      setImages((current) => {
        const next = [...current];
        const failures: string[] = [];
        let pasted =
          current.filter((image) => image.label.startsWith("Pasted image "))
            .length + 1;
        for (const file of files) {
          if (next.length >= CHAT_IMAGE_MAX_COUNT) {
            failures.push("A message can include at most four photos.");
            break;
          }
          const plausible =
            supportedMimeTypes.has(file.type.toLowerCase()) ||
            (file.type === "" && supportedExtension.test(file.name));
          if (!plausible) {
            failures.push(
              `${file.name || "Clipboard image"}: use JPEG, PNG, or WebP.`,
            );
            continue;
          }
          if (file.size === 0 || file.size > CHAT_IMAGE_MAX_SOURCE_BYTES) {
            failures.push(
              `${file.name || "Clipboard image"}: must be 10 MiB or smaller.`,
            );
            continue;
          }
          next.push({
            id:
              typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `${String(Date.now())}-${String(next.length)}`,
            file,
            label: fileLabel(file, source, pasted),
            previewUrl: objectUrl(file),
          });
          pasted += 1;
        }
        setError(failures.length === 0 ? null : failures.join(" "));
        return next;
      });
    },
    [capability],
  );

  const remove = useCallback((id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed !== undefined) revoke(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
    setError(null);
  }, []);

  const clear = useCallback(() => {
    for (const image of imagesRef.current) revoke(image.previewUrl);
    imagesRef.current = [];
    setImages((current) => (current.length === 0 ? current : []));
    setError((current) => (current === null ? current : null));
  }, []);

  useEffect(
    () => () => {
      for (const image of imagesRef.current) revoke(image.previewUrl);
    },
    [],
  );

  useEffect(() => {
    if (images.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [images.length]);

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = [...event.clipboardData.items]
        .filter(
          (item) =>
            item.kind === "file" &&
            (item.type.startsWith("image/") || item.type === ""),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (imageFiles.length === 0) return;
      event.preventDefault();
      addFiles(imageFiles, "paste");
    },
    [addFiles],
  );

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  }, []);
  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related))
      return;
    setDragging(false);
  }, []);
  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      onDropClaimed?.();
      addFiles([...event.dataTransfer.files], "drop");
    },
    [addFiles, onDropClaimed],
  );

  return {
    images,
    files: images.map((image) => image.file),
    error,
    dragging,
    addFiles,
    remove,
    clear,
    onPaste,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}

export function ChatAttachmentStrip({
  images,
  error,
  onRemove,
}: {
  images: readonly PendingChatImage[];
  error: string | null;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {images.length > 0 && (
        <ul className="chat-attachments" aria-label="Attached photos">
          {images.map((image, index) => (
            <li className="chat-attachment" key={image.id}>
              {image.previewUrl === "" ? (
                <span
                  className="chat-attachment-placeholder"
                  aria-hidden="true"
                >
                  Image
                </span>
              ) : (
                <img src={image.previewUrl} alt={`Preview of ${image.label}`} />
              )}
              <span className="chat-attachment-name" title={image.label}>
                {image.label}
              </span>
              <span className="chat-attachment-size">
                {`${String(index + 1)} of ${String(images.length)} · ${formatBytes(image.file.size)}`}
              </span>
              <button
                type="button"
                className="chat-attachment-remove"
                aria-label={`Remove ${image.label}`}
                onClick={() => {
                  onRemove(image.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <p className="chat-attachment-disclosure">
          Photos are sent to the selected model and stored in the selected
          backend's chat history.
        </p>
      )}
      {error !== null && (
        <p className="chat-attachment-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024)
    return `${String(Math.max(1, Math.round(bytes / 1024)))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
