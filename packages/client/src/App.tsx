import { useState } from 'react';
import { PROTOCOL_VERSION } from '@coedit/crdt/protocol';

/** The editor shell: a plain-text area, editing a local document until the sync client exists. */
export function App() {
  const [text, setText] = useState('');
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
          setText(event.target.value);
        }}
      />
    </main>
  );
}
