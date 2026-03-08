import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ChatItems } from "../components/chat/ChatItems";
import { PermissionModal } from "../components/chat/PermissionModal";
import { UsageFooter } from "../components/chat/UsageFooter";

export function ChatView() {
  const chat = useStore((s) => s.chat);
  const conn = useStore((s) => s.conn);
  const wsError = useStore((s) => s.wsError);
  const pendingPermission = useStore((s) => s.pendingPermission);
  const { sendTask, cancel, newSession, respondPermission, connect } = useStore.getState();

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    connect();
  }, [connect]);

  // Follow the stream: keep the list pinned to the bottom on updates.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  const submit = () => {
    const task = draft.trim();
    if (!task || chat.running) return;
    sendTask(task);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Chat</h1>
        {chat.sessionId && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-400">{chat.sessionId}</span>
        )}
        {chat.running && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            running
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {chat.running && (
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={newSession}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            New session
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {chat.items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-zinc-600">
            <div>
              <div className="mb-2 font-mono text-2xl text-zinc-700">&gt;_</div>
              <p>Describe a coding task to start a session.</p>
              <p className="mt-1 text-xs">Enter sends · Shift+Enter inserts a newline</p>
            </div>
          </div>
        ) : (
          <ChatItems items={chat.items} />
        )}
      </div>

      {wsError && (
        <div className="border-t border-amber-900 bg-amber-950/40 px-4 py-1.5 font-mono text-xs text-amber-300">
          {wsError}
        </div>
      )}

      <div className="border-t border-zinc-800 p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Don't submit while an IME composition (CJK input) is active.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={chat.running}
          placeholder={chat.running ? "agent is running…" : "What should the agent do?"}
          rows={3}
          className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none disabled:opacity-50"
        />
      </div>

      <UsageFooter usage={chat.usage} conn={conn} />

      {pendingPermission && (
        <PermissionModal request={pendingPermission.request} onRespond={respondPermission} />
      )}
    </div>
  );
}
