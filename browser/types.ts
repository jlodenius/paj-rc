export interface Command { name: string; source: string; description?: string }
export interface SessionState {
  busy?: boolean;
  runId?: string | null;
  editorBusy?: boolean;
  terminalRequired?: boolean;
  supportsImages?: boolean;
  model?: { id: string; provider: string; name?: string } | null;
  context?: { tokens: number | null; contextWindow: number } | null;
}
export type SubmissionStatus = 'submitting' | 'submitted' | 'unknown' | 'rejected';
export interface Message {
  id: string;
  role: string;
  text: string;
  imageCount?: number;
  customType?: string;
  steering?: boolean;
  observed?: boolean;
  submissionStatus?: SubmissionStatus;
}
export interface Transcript {
  generation: string | null;
  seq: number;
  state: SessionState;
  commands: Command[];
  messages: Message[];
  hasMore: boolean;
  before: string | null;
}
export interface Envelope {
  id: string;
  generation: string;
  seq: number;
  event:
    | { type: 'state'; state: SessionState }
    | { type: 'message'; message: Message }
    | { type: 'delta'; messageId: string; text: string }
    | { type: 'reset' };
}
export interface Session {
  id: string;
  generation: string;
  state: SessionState;
  name?: string;
  projectRoot?: string;
  branch?: string;
  model?: string;
}
