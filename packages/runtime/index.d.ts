export * from "./contract";

export type ExpressionEmotion = "happy" | "shy" | "shocked" | "sad" | "celebrate";

export type InteractionStatus = "delivered" | "rejected" | "expired" | "failed";

export interface ExpressionValidationResult {
  ok: boolean;
  reason?: string;
}

export interface ExpressionPayloadEcho {
  text?: string;
  emotion?: ExpressionEmotion;
}

export interface ExpressionEventPayload {
  text?: string;
  emotion?: ExpressionEmotion;
  speak: boolean;
  priority: number;
  durationMs: number;
}

export interface PetEvent {
  schemaVersion: "1";
  eventId: string;
  petId: string;
  kind: "expression";
  payload: ExpressionEventPayload;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface DeliveryReceipt {
  schemaVersion: "1";
  commandId: string;
  dedupKey: string;
  petId: string;
  status: "delivered";
  reason: null;
  payloadEcho: ExpressionPayloadEcho;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface InteractionErrorReceipt {
  schemaVersion: "1";
  commandId: string | null;
  dedupKey: string | null;
  petId: string | null;
  status: "rejected" | "expired" | "failed";
  reason: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export type InteractionReceipt = DeliveryReceipt | InteractionErrorReceipt;

export interface PetIdentityInput {
  profileId?: string;
  agentId?: string;
  rawSessionId?: string;
  id?: string;
}

export interface ExpressExpressionOptions extends PetIdentityInput {
  petId?: string;
  text?: string;
  emotion?: ExpressionEmotion | string;
  dedupKey?: string;
  commandId?: string;
  ttlMs?: number;
  createdAtMs?: number;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export type UserMessageDeliverAs = "followUp";

export type UserMessageStatus = "queued" | "dispatched" | "failed" | "expired" | "rejected";

export type SettleUserMessageStatus = "dispatched" | "failed" | "expired";

export interface UserMessage {
  schemaVersion: "1";
  kind: "user_message";
  commandId: string;
  dedupKey: string;
  petId: string;
  text: string;
  deliverAs: "followUp";
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ClaimedUserMessage {
  schemaVersion: "1";
  kind: "user_message";
  commandId: string;
  dedupKey: string;
  petId: string;
  text: string;
  deliverAs: "followUp";
  createdAtMs: number;
  expiresAtMs: number;
  claimToken: string;
  claimedAtMs: number;
  message?: UserMessage;
}

export interface UserMessagePayloadEcho {
  text?: string;
  deliverAs?: "followUp";
}

export interface UserMessageReceipt {
  schemaVersion: "1";
  kind?: "user_message";
  commandId: string | null;
  dedupKey: string | null;
  petId: string | null;
  status: UserMessageStatus;
  reason: string | null;
  text?: string;
  deliverAs?: "followUp";
  createdAtMs?: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
  payloadEcho?: UserMessagePayloadEcho;
}

export interface EnqueueUserMessageOptions extends PetIdentityInput {
  petId?: string;
  text?: string;
  deliverAs?: "followUp" | string;
  dedupKey?: string;
  commandId?: string;
  ttlMs?: number;
  createdAtMs?: number;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export interface ClaimNextUserMessageOptions extends PetIdentityInput {
  petId?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export interface SettleUserMessageOptions extends PetIdentityInput {
  petId?: string;
  commandId: string;
  claimToken: string;
  status: SettleUserMessageStatus | string;
  reason?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export interface GetUserMessageReceiptOptions extends PetIdentityInput {
  petId?: string;
  commandId?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export type PeerMessageDeliverAs = "followUp";

export type PeerMessageStatus = "queued" | "dispatched" | "failed" | "expired" | "rejected";

export type SettlePeerMessageStatus = "dispatched" | "failed" | "expired";

export interface PeerMessage {
  schemaVersion: "1";
  kind: "peer_message";
  messageId: string;
  dedupKey: string;
  targetPetId: string;
  sourcePetId: string;
  sourceDisplayName: string;
  sourceHost: string;
  text: string;
  deliverAs: "followUp";
  threadId: string;
  hopCount: number;
  maxHops: number;
  replyHandle?: string | null;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ClaimedPeerMessage {
  schemaVersion: "1";
  kind: "peer_message";
  messageId: string;
  dedupKey: string;
  targetPetId: string;
  sourcePetId: string;
  sourceDisplayName: string;
  sourceHost: string;
  text: string;
  deliverAs: "followUp";
  threadId: string;
  hopCount: number;
  maxHops: number;
  replyHandle?: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  claimToken: string;
  claimedAtMs: number;
  message?: PeerMessage;
}

export interface PeerMessagePayloadEcho {
  text?: string;
  deliverAs?: "followUp";
  threadId?: string;
  hopCount?: number;
  maxHops?: number;
  replyHandle?: string | null;
}

export interface PeerMessageReceipt {
  schemaVersion: "1";
  kind?: "peer_message";
  messageId: string | null;
  dedupKey: string | null;
  targetPetId: string | null;
  sourcePetId: string | null;
  sourceDisplayName: string | null;
  sourceHost: string | null;
  status: PeerMessageStatus;
  reason: string | null;
  text?: string;
  deliverAs?: "followUp";
  threadId?: string;
  hopCount?: number;
  maxHops?: number;
  replyHandle?: string | null;
  createdAtMs?: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
  payloadEcho?: PeerMessagePayloadEcho;
}

export interface EnqueuePeerMessageOptions {
  targetPetId: string;
  sourcePetId: string;
  sourceDisplayName: string;
  sourceHost: string;
  text: string;
  deliverAs?: "followUp" | string;
  messageId?: string;
  dedupKey?: string;
  threadId?: string;
  hopCount?: number;
  maxHops?: number;
  replyHandle?: string | null;
  ttlMs?: number;
  createdAtMs?: number;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export interface ClaimNextPeerMessageOptions {
  targetPetId: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export interface SettlePeerMessageOptions {
  targetPetId: string;
  messageId: string;
  claimToken: string;
  status: SettlePeerMessageStatus | string;
  reason?: string | null;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export interface GetPeerMessageReceiptOptions {
  sourcePetId: string;
  messageId: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fsApi?: unknown;
}

export declare function derivePetId(identity?: PetIdentityInput): string;
export declare function validateExpression(payload?: { text?: string; emotion?: string }): ExpressionValidationResult;
export declare function expressExpression(options?: ExpressExpressionOptions): InteractionReceipt;
export declare function isSafePetId(petId: string): boolean;
export declare function atomicWriteJson(targetPath: string, data: unknown, fsApi?: unknown): void;

export declare function enqueueUserMessage(options?: EnqueueUserMessageOptions): UserMessageReceipt;
export declare function claimNextUserMessage(options?: ClaimNextUserMessageOptions): ClaimedUserMessage | null;
export declare function settleUserMessage(options?: SettleUserMessageOptions): UserMessageReceipt;
export declare function getUserMessageReceipt(options?: GetUserMessageReceiptOptions): UserMessageReceipt | null;

export declare function enqueuePeerMessage(options?: EnqueuePeerMessageOptions): PeerMessageReceipt;
export declare function claimNextPeerMessage(options?: ClaimNextPeerMessageOptions): ClaimedPeerMessage | null;
export declare function settlePeerMessage(options?: SettlePeerMessageOptions): PeerMessageReceipt;
export declare function getPeerMessageReceipt(options?: GetPeerMessageReceiptOptions): PeerMessageReceipt | null;

export declare const VALID_EMOTIONS: readonly ExpressionEmotion[];
export declare const DEFAULT_TTL_MS: 30000;
export declare const MIN_TTL_MS: 1000;
export declare const MAX_TTL_MS: 300000;
export declare const MAX_ENVELOPE_SIZE: 16384;
export declare const MAX_TEXT_LENGTH: 2000;

export declare const DEFAULT_USER_MESSAGE_TTL_MS: 60000;
export declare const MIN_USER_MESSAGE_TTL_MS: 1000;
export declare const MAX_USER_MESSAGE_TTL_MS: 300000;
export declare const MAX_INBOX_QUEUE_CAPACITY: 32;
export declare const CLAIM_TIMEOUT_MS: 60000;

export declare const DEFAULT_PEER_MESSAGE_TTL_MS: 60000;
export declare const MIN_PEER_MESSAGE_TTL_MS: 1000;
export declare const MAX_PEER_MESSAGE_TTL_MS: 300000;
export declare const MAX_PEER_INBOX_QUEUE_CAPACITY: 16;
export declare const PEER_CLAIM_TIMEOUT_MS: 60000;

export type TeamRole = "leader" | "member" | "observer";
export type TeamStatus = "active" | "dissolved";
export type TeamMembershipPolicy = "user_only";

export interface TeamMember {
  petId: string;
  role: TeamRole;
  joinedAtMs: number;
}

export interface Team {
  schemaVersion: "1";
  teamId: string;
  name: string;
  status: TeamStatus;
  revision: number;
  membershipPolicy: TeamMembershipPolicy;
  leaderPetId: string;
  members: TeamMember[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TeamUserActor {
  kind: "user";
}

export type TeamActor = TeamUserActor;

export interface CreateTeamMemberInput {
  petId: string;
  role?: TeamRole;
}

export interface CreateTeamOptions {
  name: string;
  leaderPetId: string;
  members?: Array<CreateTeamMemberInput | string>;
  actor: TeamActor;
}

export interface GetTeamOptions {
  teamId: string;
}

export interface ListTeamsForPetOptions {
  petId: string;
}

export interface AddMemberOptions {
  teamId: string;
  petId: string;
  role?: "member" | "observer";
  baseRevision: number;
  actor: TeamActor;
}

export interface RemoveMemberOptions {
  teamId: string;
  petId: string;
  baseRevision: number;
  actor: TeamActor;
}

export interface SetMemberRoleOptions {
  teamId: string;
  petId: string;
  role: TeamRole;
  baseRevision: number;
  actor: TeamActor;
}

export interface DissolveTeamOptions {
  teamId: string;
  baseRevision: number;
  actor: TeamActor;
}

export interface TeamMutationSuccess {
  ok: true;
  team: Team;
}

export interface TeamMutationError {
  ok: false;
  error: string;
  reason?: string;
  currentRevision?: number;
}

export type TeamMutationResult = TeamMutationSuccess | TeamMutationError;

export interface TeamStoreConfig {
  dataDir?: string;
  env?: Record<string, string | undefined>;
  fsApi?: unknown;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

/**
 * Optimistic Concurrency Control (OCC) note:
 * Revision checking assumes operations are coordinated through a canonical single-writer coordinator.
 * Cross-process atomic CAS is not claimed.
 */
export interface TeamStore {
  createTeam(options: CreateTeamOptions): TeamMutationResult;
  getTeam(options: GetTeamOptions): Team | null;
  listTeamsForPet(options: ListTeamsForPetOptions): Team[];
  addMember(options: AddMemberOptions): TeamMutationResult;
  removeMember(options: RemoveMemberOptions): TeamMutationResult;
  setMemberRole(options: SetMemberRoleOptions): TeamMutationResult;
  dissolveTeam(options: DissolveTeamOptions): TeamMutationResult;
}

export declare function createTeamStore(config?: TeamStoreConfig): TeamStore;
export declare function isSafeTeamId(teamId: string): boolean;

export declare const MAX_TEAM_MEMBERS: 8;
export declare const MIN_TEAM_NAME_LENGTH: 1;
export declare const MAX_TEAM_NAME_LENGTH: 80;
export declare const TEAM_MEMBERSHIP_POLICY: "user_only";
export declare const VALID_TEAM_ROLES: readonly TeamRole[];
export declare const VALID_TEAM_STATUSES: readonly TeamStatus[];

export interface TeamBoardMemberActor {
  kind: "member";
  petId: string;
}

export type TeamBoardActor = TeamBoardMemberActor;

export interface BoardRecord {
  schemaVersion: "1";
  teamId: string;
  revision: number;
  markdown: string;
  updatedAtMs: number | null;
  updatedByPetId: string | null;
}

export interface ReadBoardOptions {
  teamId: string;
  actor: TeamBoardActor;
}

export interface WriteBoardOptions {
  teamId: string;
  actor: TeamBoardActor;
  baseRevision: number;
  markdown: string;
}

export interface BoardReadSuccess {
  ok: true;
  board: BoardRecord;
}

export interface BoardReadError {
  ok: false;
  error: string;
  reason?: string;
  currentRevision?: number;
}

export type BoardReadResult = BoardReadSuccess | BoardReadError;

export interface BoardWriteSuccess {
  ok: true;
  board: BoardRecord;
}

export interface BoardWriteError {
  ok: false;
  error: string;
  reason?: string;
  currentRevision?: number;
}

export type BoardWriteResult = BoardWriteSuccess | BoardWriteError;

export interface TeamBoardStoreConfig {
  teamStore?: TeamStore;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  fsApi?: unknown;
  now?: () => number;
}

/**
 * Optimistic Concurrency Control (OCC) and Actor Authentication note:
 * Trusted adapter authenticates actor and OCC assumes canonical single-writer coordinator.
 */
export interface TeamBoardStore {
  readBoard(options: ReadBoardOptions): BoardReadResult;
  writeBoard(options: WriteBoardOptions): BoardWriteResult;
}

export declare function createTeamBoardStore(config?: TeamBoardStoreConfig): TeamBoardStore;

export declare const MAX_BOARD_MARKDOWN_BYTES: 8192;
