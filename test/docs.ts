// What test/docs.test.ts checks, as functions it can also test on made-up docs: the npm commands a doc tells you to
// run, and the repo paths it names. The first version used one regex for each and missed forms review 2 tried:
// `npm -w x run y`, `--workspace=x`, a path followed by `:name` or words, a path in a link or bare in a table, and a
// `:line` past the end of the file.
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface NpmCommand {
  /** The script npm would run. */
  readonly script: string;
  /** The workspace given with -w / --workspace, if any. */
  readonly workspace: string | undefined;
  readonly text: string;
}

/** The code a Markdown text holds: each fenced block's lines, and each inline code span (which may wrap lines). */
export function codeSegments(markdown: string): string[] {
  const segments: string[] = [];
  const withoutFences = markdown.replace(/^```[^\n]*\n([\s\S]*?)^```$/gm, (_, body: string) => {
    segments.push(...body.split('\n'));
    return '';
  });
  for (const match of withoutFences.matchAll(/`([^`]+)`/g)) segments.push(match[1] ?? '');
  return segments;
}

/** Every `npm run`/`start`/`test` command in the code of a Markdown text, with its workspace. */
export function npmCommands(markdown: string): NpmCommand[] {
  const commands: NpmCommand[] = [];
  for (const segment of codeSegments(markdown)) {
    for (const piece of segment.split(/&&|\|\||;|\|/)) {
      const tokens = piece.trim().split(/\s+/);
      const at = tokens.indexOf('npm');
      if (at < 0) continue;
      let workspace: string | undefined;
      let subcommand: string | undefined;
      let script: string | undefined;
      for (let i = at + 1; i < tokens.length; i++) {
        const token = tokens[i] ?? '';
        if (token === '--') break; // what follows goes to the script
        if (token === '-w' || token === '--workspace') {
          workspace = tokens[++i];
        } else if (token.startsWith('--workspace=') || token.startsWith('-w=')) {
          workspace = token.slice(token.indexOf('=') + 1);
        } else if (token.startsWith('-')) {
          // another flag; none of the docs' commands take a value after one
        } else if (subcommand === undefined) {
          subcommand = token;
        } else if (script === undefined && (subcommand === 'run' || subcommand === 'run-script')) {
          script = token;
        }
      }
      if (subcommand === 'start' || subcommand === 'test') script = subcommand;
      if (subcommand === 't') script = 'test';
      if (script !== undefined) commands.push({ script, workspace, text: piece.trim() });
    }
  }
  return commands;
}

export interface RepoPath {
  readonly path: string;
  /** A `:line` after the path, if any. */
  readonly line: number | undefined;
}

/**
 * Every path under packages/ or test/ named anywhere in a text: in code, links, tables or prose. A path ends at the
 * first character that can't be in one (so `foo.ts:op` and `foo.ts (the reader)` both name foo.ts), and trailing
 * dots and dashes are punctuation.
 */
export function repoPaths(markdown: string): RepoPath[] {
  const paths: RepoPath[] = [];
  for (const match of markdown.matchAll(/(?<![\w./-])((?:packages|test)\/[\w./-]*)(?::(\d+))?/g)) {
    const path = (match[1] ?? '').replace(/[.-]+$/, '');
    paths.push({ path, line: match[2] === undefined ? undefined : Number(match[2]) });
  }
  return paths;
}

export interface Manifest {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

/** What's wrong with a doc's commands and paths, against the repo at `root` and its manifests. */
export function problems(
  markdown: string,
  root: string,
  rootManifest: Manifest,
  workspaces: ReadonlyMap<string, Manifest>,
): string[] {
  const found: string[] = [];
  for (const command of npmCommands(markdown)) {
    const owner =
      command.workspace === undefined ? rootManifest : workspaces.get(command.workspace);
    if (owner === undefined) {
      found.push(`no workspace ${command.workspace ?? ''} (${command.text})`);
    } else if (owner.scripts?.[command.script] === undefined) {
      found.push(`${owner.name} has no script "${command.script}" (${command.text})`);
    }
  }
  for (const { path, line } of repoPaths(markdown)) {
    const file = `${root}${path}`;
    if (!existsSync(file)) {
      found.push(`${path} does not exist`);
    } else if (line !== undefined) {
      const lines = statSync(file).isFile() ? readFileSync(file, 'utf8').split('\n').length : 0;
      if (line < 1 || line > lines) found.push(`${path}:${line} is past its ${lines} lines`);
    }
  }
  return found;
}
