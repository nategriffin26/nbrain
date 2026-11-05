export type SessionHarness = "omp" | "claude" | "codex" | "opencode" | "dross";
export type SessionScope = "work" | "life";
export type SessionPartKind = "prompt" | "answer" | "brief" | "tool_call" | "tool_result";

/** Parsed source text is private until it has passed through session redaction. */
export interface SessionPart {
  entry: string;
  ordinal: number;
  at: string | null;
  role: string;
  kind: SessionPartKind;
  tool: string | null;
  scope: SessionScope;
  text: string;
}

export interface SessionTranscript {
  id: string;
  harness: SessionHarness;
  originalPath: string;
  parentId: string | null;
  cwd: string | null;
  project: string | null;
  title: string | null;
  started: string | null;
  ended: string | null;
  scope: SessionScope;
  scratch: boolean;
  parts: SessionPart[];
}

export interface ArchivedSession {
  transcript: SessionTranscript;
  archivePath: string;
  sourceFingerprint: string;
  sourceBytes: number;
}
