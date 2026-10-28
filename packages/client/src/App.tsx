import { useState } from 'react';
import { PROTOCOL_VERSION } from '@coedit/crdt/protocol';
import { diffText, type Edit } from './edit.ts';

/**
 * The editor shell: a plain-text area editing a local document. Each input is turned into the one edit the CRDT
 * will receive once the sync client exists; for now the last one is shown, to see the mapping at work.
 */
export function App() {
  const [text, setText] = useState('');
  const [lastEdit, setLastEdit] = useState<Edit | null>(null);
  return (
    <main className="editor">
      <header>
        <h1>Coedit</h1>
        <span className="status" data-status="local">
          local only · protocol v{PROTOCOL_VERSION}
        </span>
      </header>
      <textarea
        aria-label="Document"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          const after = event.target.value;
          const edit = diffText(text, after, event.target.selectionEnd);
          if (edit !== null) setLastEdit(edit);
          setText(after);
        }}
      />
      <footer className="last-edit" aria-live="polite">
        {lastEdit === null ? 'no edits yet' : describe(lastEdit)}
      </footer>
    </main>
  );
}

function describe(edit: Edit): string {
  const parts: string[] = [];
  if (edit.deleteCount > 0) parts.push(`delete ${edit.deleteCount}`);
  if (edit.text !== '') parts.push(`insert ${JSON.stringify(edit.text)}`);
  return `last edit: at ${edit.index}, ${parts.join(', ')}`;
}
