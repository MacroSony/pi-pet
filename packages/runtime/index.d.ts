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

export declare function derivePetId(identity?: PetIdentityInput): string;
export declare function validateExpression(payload?: { text?: string; emotion?: string }): ExpressionValidationResult;
export declare function expressExpression(options?: ExpressExpressionOptions): InteractionReceipt;
export declare function isSafePetId(petId: string): boolean;
export declare function atomicWriteJson(targetPath: string, data: unknown, fsApi?: unknown): void;

export declare function enqueueUserMessage(options?: EnqueueUserMessageOptions): UserMessageReceipt;
export declare function claimNextUserMessage(options?: ClaimNextUserMessageOptions): ClaimedUserMessage | null;
export declare function settleUserMessage(options?: SettleUserMessageOptions): UserMessageReceipt;
export declare function getUserMessageReceipt(options?: GetUserMessageReceiptOptions): UserMessageReceipt | null;

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
