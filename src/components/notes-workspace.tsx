"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SignOutButton } from "@/components/sign-out-button";

type NoteSummary = {
  id: string;
  title: string;
  parentId: string | null;
  updatedAt: string;
  childCount?: number;
};

type Note = NoteSummary & { content: string };

type SearchHit = {
  id: string;
  title: string;
  snippet: string;
  breadcrumb: { id: string; title: string }[];
};

type SaveState = "idle" | "saving" | "saved" | "error";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? "Something went wrong");
  return data as T;
}

// ts_headline wraps matches in <b> tags; show them as plain text.
const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");

function TreeNode({
  note,
  depth,
  selectedId,
  refreshKey,
  onSelect,
  onCreate,
  onDelete,
}: {
  note: NoteSummary;
  depth: number;
  selectedId: string | null;
  refreshKey: number;
  onSelect: (id: string) => void;
  onCreate: (parentId: string) => Promise<void>;
  onDelete: (note: NoteSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<NoteSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ notes: NoteSummary[] }>(`/api/notes?parentId=${note.id}`)
      .then((d) => !cancelled && setChildren(d.notes))
      .catch(() => !cancelled && setChildren([]));
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey, note.id]);

  const hasChildren = (note.childCount ?? 0) > 0 || (children?.length ?? 0) > 0;

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded-md py-1 pr-1 text-sm ${
          selectedId === note.id ? "bg-black/10 dark:bg-white/15" : "hover:bg-black/5 dark:hover:bg-white/10"
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((o) => !o)}
          className={`w-4 text-xs text-gray-500 ${hasChildren ? "" : "invisible"}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(note.id)}
          className="min-w-0 flex-1 truncate text-left"
        >
          {note.title || "Untitled"}
        </button>
        <button
          type="button"
          title="Add sub-note"
          onClick={async () => {
            setOpen(true);
            await onCreate(note.id);
          }}
          className="hidden rounded px-1 text-gray-500 hover:text-foreground group-hover:block"
        >
          +
        </button>
        <button
          type="button"
          title="Delete"
          onClick={() => onDelete(note)}
          className="hidden rounded px-1 text-gray-500 hover:text-red-600 group-hover:block"
        >
          ×
        </button>
      </div>
      {open && children && (
        <ul>
          {children.map((c) => (
            <TreeNode
              key={c.id}
              note={c}
              depth={depth + 1}
              selectedId={selectedId}
              refreshKey={refreshKey}
              onSelect={onSelect}
              onCreate={onCreate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Editor({
  noteId,
  onSaved,
}: {
  noteId: string;
  onSaved: (note: Note) => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    // The parent remounts this component per note (key), so state starts fresh.
    let cancelled = false;
    api<{ note: Note }>(`/api/notes/${noteId}`)
      .then(({ note }) => {
        if (cancelled) return;
        setNote(note);
        setTitle(note.title);
        setContent(note.content);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // Debounced autosave.
  useEffect(() => {
    if (!dirty.current || !title.trim()) return;
    const t = setTimeout(async () => {
      setState("saving");
      try {
        const { note: saved } = await api<{ note: Note }>(`/api/notes/${noteId}`, {
          method: "PATCH",
          body: JSON.stringify({ title: title.trim(), content }),
        });
        setState("saved");
        onSaved(saved);
      } catch (e) {
        setState("error");
        setError((e as Error).message);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [title, content, noteId, onSaved]);

  if (error && !note) return <p className="p-8 text-red-600">{error}</p>;
  if (!note) return <p className="p-8 text-gray-500">Loading…</p>;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 p-8">
      <input
        value={title}
        onChange={(e) => {
          dirty.current = true;
          setTitle(e.target.value);
        }}
        placeholder="Untitled"
        maxLength={200}
        className="bg-transparent text-3xl font-semibold outline-none"
      />
      <textarea
        value={content}
        onChange={(e) => {
          dirty.current = true;
          setContent(e.target.value);
        }}
        placeholder="Start writing…"
        className="min-h-[50vh] flex-1 resize-none bg-transparent leading-relaxed outline-none"
      />
      <p className="text-xs text-gray-500">
        {state === "saving" && "Saving…"}
        {state === "saved" && "All changes saved"}
        {state === "error" && <span className="text-red-600">{error}</span>}
        {state === "idle" && `Last edited ${new Date(note.updatedAt).toLocaleString()}`}
      </p>
    </div>
  );
}

export function NotesWorkspace({ email }: { email: string }) {
  const [roots, setRoots] = useState<NoteSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ notes: NoteSummary[] }>("/api/notes")
      .then((d) => !cancelled && setRoots(d.notes))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Debounced full-text search.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<{ results: SearchHit[] }>(`/api/notes/search?q=${encodeURIComponent(q)}`)
        .then((d) => !cancelled && setHits(d.results))
        .catch(() => !cancelled && setHits([]));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const shownHits = query.trim() ? hits : null;

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  async function createNote(parentId: string | null) {
    try {
      const { note } = await api<{ note: Note }>("/api/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Untitled", content: "", parentId }),
      });
      setSelectedId(note.id);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteNote(note: NoteSummary) {
    const extra = note.childCount ? " and all of its sub-notes" : "";
    if (!window.confirm(`Delete "${note.title || "Untitled"}"${extra}?`)) return;
    try {
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
      if (selectedId === note.id) setSelectedId(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <span className="truncate text-sm text-gray-500" title={email}>
            {email}
          </span>
          <SignOutButton />
        </div>

        <div className="space-y-2 p-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes…"
            className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => createNote(null)}
            className="w-full rounded-md bg-black py-1.5 text-sm text-white dark:bg-white dark:text-black"
          >
            + New note
          </button>
        </div>

        {error && <p className="px-3 pb-2 text-xs text-red-600">{error}</p>}

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {shownHits ? (
            shownHits.length === 0 ? (
              <p className="px-2 text-sm text-gray-500">No results.</p>
            ) : (
              <ul className="space-y-1">
                {shownHits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(h.id)}
                      className="w-full rounded-md p-2 text-left hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <span className="block truncate text-sm font-medium">{h.title || "Untitled"}</span>
                      {h.breadcrumb.length > 0 && (
                        <span className="block truncate text-xs text-gray-500">
                          {h.breadcrumb.map((b) => b.title).join(" › ")}
                        </span>
                      )}
                      <span className="line-clamp-2 text-xs text-gray-500">{stripTags(h.snippet)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : roots === null ? (
            <p className="px-2 text-sm text-gray-500">Loading…</p>
          ) : roots.length === 0 ? (
            <p className="px-2 text-sm text-gray-500">No notes yet. Create your first one.</p>
          ) : (
            <ul>
              {roots.map((n) => (
                <TreeNode
                  key={n.id}
                  note={n}
                  depth={0}
                  selectedId={selectedId}
                  refreshKey={refreshKey}
                  onSelect={setSelectedId}
                  onCreate={createNote}
                  onDelete={deleteNote}
                />
              ))}
            </ul>
          )}
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {selectedId ? (
          <Editor key={selectedId} noteId={selectedId} onSaved={refresh} />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            Select a note or create a new one.
          </div>
        )}
      </main>
    </div>
  );
}
