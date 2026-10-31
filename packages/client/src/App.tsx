import { useEffect, useRef, useState } from 'react';
import { MAX_DOC_LENGTH, PROTOCOL_VERSION } from '@coedit/crdt/protocol';
import { codePointToUtf16, diffText, utf16ToCodePoint } from './edit.ts';
import { SyncClient, type Selection, type Status } from './sync.ts';
import { applyChanges, replicaHue } from './textarea.ts';

const DOC_NAME = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_DOC_LENGTH}}$`);

/** The document named by `?doc=` (default "welcome"), or null if the name isn't one the protocol allows. */
function docFromLocation(): string | null {
  const doc = new URLSearchParams(window.location.search).get('doc') ?? 'welcome';
  return DOC_NAME.test(doc) ? doc : null;
}

/**
 * The sync endpoint on this page's own host: the dev server (and `vite preview`) proxy /sync to the sync server
 * (vite.config.ts), so the page and the socket share an origin.
 */
function syncUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/sync`;
}

export function App() {
  const doc = docFromLocation();
  if (doc === null) {
    return (
      <main className="editor">
        <p role="alert">
          A document name is 1 to {MAX_DOC_LENGTH} characters of A-Z a-z 0-9 _ - (in{' '}
          <code>?doc=</code>).
        </p>
      </main>
    );
  }
  return <Editor doc={doc} url={syncUrl()} />;
}

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'connecting',
  syncing: 'catching up',
  online: 'online',
  offline: 'offline',
  failed: 'stopped',
  stopped: 'offline (by choice)',
};

/**
 * The editor: a textarea over one SyncClient. The textarea is uncontrolled: what it shows is patched in place by
 * remote changes (so the caret and the scroll position survive), and each input is turned into one edit by
 * comparing it with `shown`, the text the replica held when the textarea last agreed with it.
 */
function Editor({ doc, url }: { doc: string; url: string }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const shown = useRef('');
  const composing = useRef(false);
  const [client, setClient] = useState<SyncClient | null>(null);
  const [status, setStatus] = useState<{ status: Status; detail: string }>({
    status: 'connecting',
    detail: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  // What `shown` holds, for rendering the cursors (a ref can't be read while rendering).
  const [text, setText] = useState('');
  // Bumped when the cursors or the counts shown may have changed.
  const [, setVersion] = useState(0);

  useEffect(() => {
    const ta = textarea.current;
    if (ta === null) return;
    // A new client is a new, empty replica (a tab that reloads is a new replica too).
    ta.value = '';
    shown.current = '';
    setText('');
    const bump = () => {
      setVersion((v) => v + 1);
    };
    const c = new SyncClient(
      { url, doc },
      {
        onStatus: (s, detail) => {
          setStatus({ status: s, detail });
        },
        onPresence: bump,
        onProgress: bump,
        onChanges: (changes) => {
          // Between events the textarea holds what the replica held before these changes: input events are
          // turned into edits as they come, and while a composition is open the client holds remote changes.
          const scrollTop = ta.scrollTop;
          const direction = ta.selectionDirection;
          const next = applyChanges(
            { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
            changes,
          );
          ta.value = next.text;
          ta.setSelectionRange(next.start, next.end, direction);
          ta.scrollTop = scrollTop;
          shown.current = next.text;
          setText(next.text);
        },
      },
    );
    setClient(c);
    c.start();
    return () => {
      c.stop();
    };
  }, [doc, url]);

  const sendSelection = () => {
    const ta = textarea.current;
    if (ta === null || client === null || composing.current || ta.value !== shown.current) return;
    const start = utf16ToCodePoint(ta.value, ta.selectionStart);
    const end = utf16ToCodePoint(ta.value, ta.selectionEnd);
    const backward = ta.selectionDirection === 'backward';
    client.select({ anchor: backward ? end : start, head: backward ? start : end });
  };

  /** Turns what the textarea now shows into one edit of the replica. */
  const syncInput = () => {
    const ta = textarea.current;
    if (ta === null || client === null) return;
    const after = ta.value;
    const edit = diffText(shown.current, after, ta.selectionEnd);
    if (edit !== null) {
      try {
        client.edit(edit.index, edit.deleteCount, edit.text);
      } catch (error) {
        // The replica refused it (full, or its clock used up): show the text it does hold.
        ta.value = shown.current;
        setProblem(`That edit couldn't be made: ${(error as Error).message}`);
        return;
      }
      shown.current = after;
      setText(after);
    }
    sendSelection();
  };

  const others = client?.remoteSelections() ?? new Map<string, Selection>();
  const waiting = client?.unacknowledged ?? 0;
  const offlineByChoice = status.status === 'stopped';

  return (
    <main className="editor">
      <header>
        <h1>Coedit</h1>
        <span className="status" data-status={status.status} title={status.detail}>
          {doc} · {STATUS_TEXT[status.status]}
          {waiting > 0 ? ` · ${waiting} edit${waiting === 1 ? '' : 's'} not yet acknowledged` : ''}
          {others.size > 0 ? ` · ${others.size} other${others.size === 1 ? '' : 's'} here` : ''}
          {' · '}protocol v{PROTOCOL_VERSION}
        </span>
        <button
          type="button"
          disabled={client === null || status.status === 'failed'}
          onClick={() => {
            if (client === null) return;
            if (offlineByChoice) client.start();
            else client.stop();
          }}
        >
          {offlineByChoice ? 'Go online' : 'Go offline'}
        </button>
      </header>
      {status.status === 'failed' ? (
        <p role="alert" className="problem">
          Sync stopped: {status.detail}. Your text is still here; copy it before reloading, since
          edits the server hasn&apos;t acknowledged are lost on reload.
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="problem">
          {problem}
        </p>
      )}
      <div className="surface">
        <div className="mirror" ref={mirror} aria-hidden="true">
          <Cursors text={text} others={others} />
        </div>
        <textarea
          ref={textarea}
          aria-label="Document"
          spellCheck={false}
          defaultValue=""
          onChange={() => {
            if (!composing.current) syncInput();
          }}
          onSelect={sendSelection}
          onScroll={(event) => {
            if (mirror.current !== null) mirror.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onCompositionStart={() => {
            composing.current = true;
            client?.hold();
          }}
          onCompositionEnd={() => {
            composing.current = false;
            syncInput();
            client?.release();
          }}
        />
      </div>
    </main>
  );
}

/**
 * The others' carets and selections, drawn in a copy of the text laid out like the textarea's, behind it (the text
 * itself transparent). The text is cut at every caret and selection end; each piece is shaded for the selections
 * covering it, each caret is a colored bar.
 */
function Cursors({ text, others }: { text: string; others: Map<string, Selection> }) {
  const marks = [...others].map(([replica, s]) => {
    const anchor = codePointToUtf16(text, Math.min(s.anchor, Array.from(text).length));
    const head = codePointToUtf16(text, Math.min(s.head, Array.from(text).length));
    return {
      replica,
      hue: replicaHue(replica),
      head,
      from: Math.min(anchor, head),
      to: Math.max(anchor, head),
    };
  });
  const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.from, m.to, m.head])])].sort(
    (a, b) => a - b,
  );
  const pieces = [];
  for (let i = 0; i < cuts.length; i++) {
    const at = cuts[i] as number;
    for (const m of marks) {
      if (m.head === at) {
        pieces.push(
          <span
            key={`caret-${m.replica}`}
            className="remote-caret"
            style={{ borderColor: `hsl(${m.hue} 80% 45%)` }}
            data-replica={m.replica}
          >
            <span className="remote-label" style={{ background: `hsl(${m.hue} 80% 45%)` }}>
              {m.replica.slice(0, 4)}
            </span>
          </span>,
        );
      }
    }
    const next = cuts[i + 1];
    if (next === undefined) break;
    const covering = marks.find((m) => m.from <= at && next <= m.to);
    pieces.push(
      <span
        key={`text-${at}`}
        style={
          covering === undefined ? undefined : { background: `hsl(${covering.hue} 80% 60% / 0.3)` }
        }
      >
        {text.slice(at, next)}
      </span>,
    );
  }
  // A textarea shows an empty last line after a final newline; a div shows it only if something follows.
  pieces.push(<span key="end">{'​'}</span>);
  return <>{pieces}</>;
}
