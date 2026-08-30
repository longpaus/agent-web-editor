// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatAttachmentStrip, useChatAttachments } from "./chatAttachments.js";

const revokeObjectURL = vi.fn();

function Harness({
  capability = "supported",
}: {
  capability?: "supported" | "unsupported" | "unknown";
}) {
  const attachments = useChatAttachments(capability);
  return (
    <form {...attachments.dropHandlers}>
      <ChatAttachmentStrip
        images={attachments.images}
        error={attachments.error}
        onRemove={attachments.remove}
      />
      <textarea aria-label="Message" onPaste={attachments.onPaste} />
    </form>
  );
}

function png(name = "shot.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("chat image attachment input", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "image-id") });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:preview"),
    });
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attaches an image pasted into the focused composer and consumes fallback clipboard text", () => {
    render(<Harness />);
    const file = png("image.png");
    const accepted = fireEvent.paste(
      screen.getByRole("textbox", { name: "Message" }),
      {
        clipboardData: {
          items: [
            { kind: "file", type: "image/png", getAsFile: () => file },
            { kind: "string", type: "text/plain", getAsFile: () => null },
          ],
        },
      },
    );

    expect(accepted).toBe(false);
    expect(
      screen.getByRole("img", { name: "Preview of Pasted image 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Pasted image 1" }),
    ).toBeInTheDocument();
  });

  it("attaches a blank-MIME pasted image when its filename is supported", () => {
    render(<Harness />);
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", {
      type: "",
    });
    const accepted = fireEvent.paste(
      screen.getByRole("textbox", { name: "Message" }),
      {
        clipboardData: {
          items: [{ kind: "file", type: "", getAsFile: () => file }],
        },
      },
    );

    expect(accepted).toBe(false);
    expect(
      screen.getByRole("img", { name: "Preview of photo.png" }),
    ).toBeInTheDocument();
  });

  it("does not consume an ordinary text-only paste", () => {
    render(<Harness />);
    const accepted = fireEvent.paste(
      screen.getByRole("textbox", { name: "Message" }),
      {
        clipboardData: {
          items: [
            { kind: "string", type: "text/plain", getAsFile: () => null },
          ],
        },
      },
    );
    expect(accepted).toBe(true);
    expect(screen.queryByRole("list", { name: "Attached photos" })).toBeNull();
  });

  it("adds dropped images, rejects unrelated files, and removes previews", () => {
    render(<Harness />);
    const image = png();
    const text = new File(["hello"], "notes.txt", { type: "text/plain" });
    const form = screen
      .getByRole("textbox", { name: "Message" })
      .closest("form");
    expect(form).not.toBeNull();
    if (form === null) throw new Error("composer form was not rendered");
    fireEvent.drop(form, {
      dataTransfer: { types: ["Files"], files: [image, text] },
    });

    expect(
      screen.getByRole("img", { name: "Preview of shot.png" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "notes.txt: use JPEG, PNG, or WebP",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(
      screen.queryByRole("img", { name: "Preview of shot.png" }),
    ).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("shows no file-picker row or unsupported explanation", () => {
    render(<Harness capability="unsupported" />);
    expect(screen.queryByLabelText("＋ Add photos")).not.toBeInTheDocument();
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => png() }],
      },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Attached photos" })).toBeNull();
  });

  it("retains pending images when capability becomes unsupported", () => {
    const view = render(<Harness capability="supported" />);
    const form = screen
      .getByRole("textbox", { name: "Message" })
      .closest("form");
    if (form === null) throw new Error("Expected a composer form");
    fireEvent.drop(form, {
      dataTransfer: { types: ["Files"], files: [png()] },
    });
    expect(
      screen.getByRole("img", { name: "Preview of shot.png" }),
    ).toBeInTheDocument();

    view.rerender(<Harness capability="unsupported" />);
    expect(
      screen.getByRole("img", { name: "Preview of shot.png" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("＋ Add photos")).not.toBeInTheDocument();
  });
});
