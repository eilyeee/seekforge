import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../../lib/api";
import { TerminalScreen, type CellStyle } from "../../lib/ansi";
import { useT } from "../../lib/i18n";
import { detectLoopbackUrls } from "../../lib/preview-urls";
import { openTerminalConnection, type TerminalConnection } from "../../lib/terminal-client";
import { keyToInput, pasteToInput } from "../../lib/terminal-keys";
import { Button, Input } from "../ui";

const MAX_RENDERED_LINES = 1_000;
const URL_SCAN_CHARS = 16_000;

/** Inline style for one span; the 16 base colors follow the app theme. */
export function spanStyle(style: CellStyle): CSSProperties | undefined {
  if (
    style.fg === undefined &&
    style.bg === undefined &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.inverse
  ) {
    return undefined;
  }
  const color = (value: string | undefined) =>
    value === undefined ? undefined : value.startsWith("ansi:") ? `rgb(var(--sf-ansi-${value.slice(5)}))` : value;
  let fg = color(style.fg);
  let bg = color(style.bg);
  if (style.inverse) {
    [fg, bg] = [bg ?? "rgb(var(--sf-terminal-bg))", fg ?? "rgb(var(--sf-terminal-fg))"];
  }
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.dim ? { opacity: 0.7 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.underline ? { textDecoration: "underline" } : {}),
  };
}

type Status = "idle" | "starting" | "ready" | "exited" | "unavailable";

type Props = {
  workspaceId: string;
  visible: boolean;
  /** Loopback URLs seen in the terminal output, newest last. */
  onUrls: (urls: string[]) => void;
};

/**
 * A shell in the workspace, over /ws/terminal. The output view understands
 * common ANSI sequences (lib/ansi.ts); keys typed into it go straight to the
 * shell, and the input line below composes text (IME, paste) before sending.
 * The panel stays mounted while the dock is hidden so the shell keeps running.
 */
export function TerminalPanel({ workspaceId, visible, onUrls }: Props) {
  const t = useT();
  const screenRef = useRef(new TerminalScreen(100, 30));
  const connectionRef = useRef<TerminalConnection | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const rawTail = useRef("");
  const followRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  /** Bumped by every start/kill, so a slow availability check cannot open a stale shell. */
  const generation = useRef(0);
  const [, setVersion] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [boundWorkspace, setBoundWorkspace] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const onUrlsRef = useRef(onUrls);
  onUrlsRef.current = onUrls;
  const urlsKey = useRef("");

  const scheduleRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setVersion(screenRef.current.version);
    });
  }, []);

  const size = useCallback((): { cols: number; rows: number } => {
    const box = outputRef.current?.getBoundingClientRect();
    const glyph = measureRef.current?.getBoundingClientRect();
    const charW = glyph && glyph.width > 0 ? glyph.width : 7.2;
    const charH = glyph && glyph.height > 0 ? glyph.height : 16;
    return {
      cols: Math.min(500, Math.max(20, Math.floor(((box?.width ?? 800) - 16) / charW))),
      rows: Math.min(300, Math.max(5, Math.floor(((box?.height ?? 300) - 8) / charH))),
    };
  }, []);

  const start = useCallback(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
    const started = ++generation.current;
    const target = workspaceId;
    setStatus("starting");
    setMessage(null);
    api
      .terminal(target || undefined)
      .then((availability) => {
        if (started !== generation.current) return;
        if (!availability.available) {
          setStatus("unavailable");
          setMessage(availability.reason);
          return;
        }
        const { cols, rows } = size();
        const screen = new TerminalScreen(cols, rows);
        screenRef.current = screen;
        rawTail.current = "";
        followRef.current = true;
        setBoundWorkspace(target);
        setCwd(availability.cwd);
        const connection = openTerminalConnection(api.terminalUrl(target, cols, rows), {
          onFrame: (frame) => {
            if (connectionRef.current !== connection) return;
            if (frame.type === "ready") {
              setStatus("ready");
              setCwd(frame.cwd);
              if (!frame.pty) setMessage(t("dock.terminalNoPty"));
            } else if (frame.type === "output") {
              screen.write(frame.data);
              rawTail.current = (rawTail.current + frame.data).slice(-URL_SCAN_CHARS);
              const urls = detectLoopbackUrls(rawTail.current);
              if (urls.join("\n") !== urlsKey.current) {
                urlsKey.current = urls.join("\n");
                onUrlsRef.current(urls);
              }
              scheduleRender();
            } else if (frame.type === "exit") {
              setStatus("exited");
              setMessage(t("dock.terminalExited", { code: String(frame.code ?? frame.signal ?? "?") }));
            } else {
              setMessage(frame.message);
            }
          },
          onClose: () => {
            if (connectionRef.current !== connection) return;
            connectionRef.current = null;
            setStatus((current) => (current === "exited" || current === "unavailable" ? current : "exited"));
          },
        });
        connectionRef.current = connection;
        scheduleRender();
      })
      .catch((e: unknown) => {
        if (started !== generation.current) return;
        setStatus("unavailable");
        setMessage(e instanceof Error ? e.message : String(e));
      });
  }, [scheduleRender, size, t, workspaceId]);

  // First show starts a shell; later shows reuse it.
  useEffect(() => {
    if (visible && status === "idle") start();
  }, [visible, status, start]);

  useEffect(
    () => () => {
      generation.current++;
      connectionRef.current?.close();
      connectionRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // Best-effort resize: the server applies it to the PTY when it can.
  useEffect(() => {
    const element = outputRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!visible) return;
        const { cols, rows } = size();
        const screen = screenRef.current;
        if (cols === screen.cols && rows === screen.rows) return;
        screen.resize(cols, rows);
        connectionRef.current?.resize(cols, rows);
        scheduleRender();
      }, 150);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scheduleRender, size, visible]);

  useLayoutEffect(() => {
    const element = outputRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  const send = (data: string) => {
    if (data !== "") connectionRef.current?.input(data);
  };

  const lines = screenRef.current.snapshot().slice(-MAX_RENDERED_LINES);
  const live = status === "ready" || status === "starting";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-3 py-1.5 text-2xs">
        <span className="truncate font-mono text-tertiary" title={cwd}>
          {cwd || t("dock.terminal")}
        </span>
        {boundWorkspace !== null && boundWorkspace !== workspaceId && live && (
          <span className="text-warn">{t("dock.terminalOtherWorkspace")}</span>
        )}
        {message && <span className="truncate text-warn">{message}</span>}
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={!live} onClick={() => send(String.fromCharCode(3))}>
            Ctrl+C
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              screenRef.current.clear();
              scheduleRender();
            }}
          >
            {t("dock.terminalClear")}
          </Button>
          {live ? (
            <Button
              size="sm"
              variant="ghost"
              className="hover:text-danger"
              onClick={() => {
                generation.current++;
                connectionRef.current?.close();
                connectionRef.current = null;
                setStatus("exited");
                setMessage(t("dock.terminalKilled"));
              }}
            >
              {t("dock.terminalKill")}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={start}>
              {t("dock.terminalRestart")}
            </Button>
          )}
        </span>
      </div>
      <div
        ref={outputRef}
        role="log"
        aria-label={t("dock.terminal")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the output area is where keystrokes go to the shell
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || !live) return;
          const data = keyToInput(e);
          if (data === null) return;
          e.preventDefault();
          followRef.current = true;
          send(data);
        }}
        onPaste={(e) => {
          if (!live) return;
          e.preventDefault();
          send(pasteToInput(e.clipboardData.getData("text")));
        }}
        className="focus-ring relative min-h-0 flex-1 overflow-auto bg-terminal px-2 py-1 font-mono text-xs leading-4 text-terminal"
      >
        <span ref={measureRef} aria-hidden className="invisible absolute font-mono text-xs leading-4">
          M
        </span>
        {lines.map((spans, index) => (
          <div key={index} className="min-h-4 whitespace-pre">
            {spans.map((span, at) => (
              <span key={at} style={spanStyle(span.style)}>
                {span.text}
              </span>
            ))}
          </div>
        ))}
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-subtle px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          followRef.current = true;
          send(`${pasteToInput(line)}\r`);
          setLine("");
        }}
      >
        <span className="font-mono text-xs text-tertiary">$</span>
        <Input
          value={line}
          disabled={!live}
          onChange={(e) => setLine(e.target.value)}
          placeholder={t("dock.terminalInputPlaceholder")}
          aria-label={t("dock.terminalInputPlaceholder")}
          className="flex-1 py-1 font-mono text-xs"
        />
        <Button size="sm" type="submit" disabled={!live}>
          {t("dock.terminalSend")}
        </Button>
      </form>
    </div>
  );
}
