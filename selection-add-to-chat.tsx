// "Add to chat" for text highlighted in a sage's chat, as bb's own thread
// timeline offers it. bb shows that menu only on its thread pages, and a
// ThreadChat embedded without a composer shows none, so the sage page draws
// its own: the same menu, quoting the selection into the sage's composer.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useComposers, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";

// bb's TimelineSelectionMenu classes, so the menu looks the same.
const MENU_CLASS =
  "pointer-events-auto z-50 flex w-auto items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
const BUTTON_CLASS =
  "inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring select-none max-md:pointer-coarse:min-h-7 max-md:pointer-coarse:px-2 max-md:pointer-coarse:py-1";
const COLLISION_PADDING = 8;
/** Selections in these are the user's own input, not the chat. */
const NOT_CHAT = "input, textarea, select, [contenteditable], button";

/** bb's quoting: each line behind "> ", appended to the draft. */
export function appendQuote(draftText: string, selected: string): string {
  const trimmed = selected.replace(/\n{3,}/gu, "\n\n").trim();
  if (trimmed === "") return draftText;
  const block = trimmed
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return draftText === "" ? `${block}\n` : `${draftText}\n${block}\n`;
}

/** The selection inside `root`, or null for none or one partly outside it. */
function chatSelection(root: HTMLElement): { text: string; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  const inChat = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return (
      element !== null && root.contains(element) && element.closest(NOT_CHAT) === null
    );
  };
  if (!inChat(range.startContainer) || !inChat(range.endContainer)) return null;
  const text = selection.toString();
  if (text.trim() === "") return null;
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const rect = rects[0] ?? range.getBoundingClientRect();
  return { text, rect };
}

/**
 * Watches `root` for highlighted text and offers to quote it into the
 * composer whose draft key is `draftKey`.
 */
export function SelectionAddToChat({
  root,
  draftKey,
}: {
  root: RefObject<HTMLElement | null>;
  draftKey: string;
}) {
  const composers = useComposers();
  const composer: PluginComposerApi | undefined = useMemo(() => {
    const drafts = composers.filter((each) => each.scope.kind === "new-thread");
    return drafts.find((each) => each.key.includes(draftKey)) ?? drafts.at(-1);
  }, [composers, draftKey]);
  const portalScopeProps = usePortalScopeProps();
  const [selection, setSelection] = useState<{
    text: string;
    rect: DOMRect;
  } | null>(null);

  useEffect(() => {
    // Shown once the pointer lets go, like bb's: not while dragging.
    let dragging = false;
    const read = () => {
      const element = root.current;
      setSelection(element === null ? null : chatSelection(element));
    };
    const onDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.("[data-sage-selection-menu]"))
        return;
      dragging = true;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      // After the browser settles the selection a click collapses.
      setTimeout(read, 0);
    };
    const onChange = () => {
      if (dragging) return;
      const selected = window.getSelection();
      // Keyboard selections show too; a collapse hides the menu at once.
      if (selected === null || selected.isCollapsed) setSelection(null);
      else read();
    };
    const onScroll = () => setSelection(null);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("selectionchange", onChange);
    root.current?.addEventListener("scroll", onScroll, true);
    const element = root.current;
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("selectionchange", onChange);
      element?.removeEventListener("scroll", onScroll, true);
    };
  }, [root]);

  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  if (selection === null || composer === undefined) return null;
  const { rect } = selection;
  anchor.current = {
    getBoundingClientRect: () => new DOMRect(rect.left + rect.width / 2, rect.top, 0, 0),
  };

  const add = () => {
    composer.replace((draft) => ({
      ...draft,
      text: appendQuote(draft.text, selection.text),
    }));
    composer.focus();
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) setSelection(null);
      }}
    >
      <PopoverPrimitive.Anchor virtualRef={anchor} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScopeProps}
          data-sage-selection-menu=""
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={COLLISION_PADDING}
          className={MENU_CLASS}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The selection is the dismissal state: a click in the chat that
          // clears it closes the menu; one that makes a new one moves it.
          onInteractOutside={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className={BUTTON_CLASS}
            // Keeps the highlight while the button is pressed.
            onMouseDown={(event) => event.preventDefault()}
            onClick={add}
          >
            <Icon
              name="MessageSquarePlus"
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            Add to chat
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
