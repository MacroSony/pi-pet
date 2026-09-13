/** Machine-readable phase-1 boundary types.
 *
 * The status-file names are snake_case because they are the fields read by
 * claude-status-pet's Rust StatusPayload. Runtime/Clawd input is camelCase.
 */
export type PetState =
  | "idle" | "thinking" | "reading" | "editing" | "searching"
  | "running" | "delegating" | "waiting" | "error" | "closed" | "offline";

export interface TeamPresentationMember {
  displayName: string;
  role: "leader" | "member" | "observer";
  state: PetState;
  host: string;
}

export interface TeamBoardPresentation {
  status: "ready" | "unavailable";
  revision: number | null;
  markdown: string;
  updatedBy: string;
}

export interface TeamPresentation {
  name: string;
  role: "leader" | "member" | "observer";
  members: readonly TeamPresentationMember[];
  board: TeamBoardPresentation;
}

export interface PetStatus {
  state: PetState;
  detail: string;
  tool: string;
  event: string;
  sessionId: string;
  sessionName: string;
  timestamp: string;
  team?: TeamPresentation | null;
}

/** JSON written by the runtime. timestamp is retained for runtime/file
 * watchers; the Rust renderer currently reads the other six fields. */
export interface PetStatusFile {
  state: PetState;
  detail: string;
  tool: string;
  event: string;
  session_id: string;
  session_name: string;
  timestamp: string;
  team?: TeamPresentation | null;
}

export interface RuntimeOptions {
  enabled?: boolean;
  statusDir?: string;
  rendererBinary?: string;
  assetsDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface PetRuntimeResult {
  written: number;
  launched: number;
}

export interface PetRuntime {
  readonly enabled: boolean;
  onSnapshot(snapshot: { statuses: readonly PetStatus[] }): PetRuntimeResult;
  onSessionEnd(status: PetStatus): boolean;
  statusPathFor(sessionId: string): string;
}

/** Minimal fields selected from Clawd's real buildSessionSnapshot output. */
export interface ClawdSnapshotSession {
  id: string;
  profileId: string;
  rawSessionId: string;
  agentId: string | null;
  agentName: string;
  state: string;
  toolName: string | null;
  displayFolder: string;
  sourceDisplayLabel: string;
  updatedAt: number;
  headless: boolean;
  displayTitle?: string;
  lastEvent: { rawEvent: string | null; at: number } | null;
}

export interface ClawdSnapshot {
  sessions: readonly ClawdSnapshotSession[];
}

export interface ClawdRuntimeOptions extends RuntimeOptions {
  agentIds?: readonly string[];
}

export interface ClawdPresentationBridge extends Omit<PetRuntime, "onSnapshot" | "onSessionEnd"> {
  onSnapshot(snapshot: ClawdSnapshot): PetRuntimeResult;
  onSessionEnd(entry: ClawdSnapshotSession): boolean;
}

export declare function createPetRuntime(options?: RuntimeOptions): PetRuntime;
export declare function createClawdPresentationBridge(
  options?: ClawdRuntimeOptions,
): ClawdPresentationBridge;
export declare function isSafeSessionId(sessionId: string): boolean;
export declare const API_CONTRACT_VERSION: "1";
export declare const API_CONTRACT: unknown;
export declare const PET_STATUS_SCHEMA: unknown;
export declare const STATUS_FILE_SCHEMA: unknown;
export declare const REACTION_SCHEMA: {
  readonly rendererImplemented: true;
  readonly runtimeImplemented: false;
  readonly emittedByRuntime: false;
};
