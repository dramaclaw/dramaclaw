// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type {
  AcceptInviteRequest,
  AddMemberRequest,
  BatchMemberResult,
  BatchMembersRequest,
  CreateInviteRequest,
  IdempotentRequest,
  Invite,
  InviteAcceptResult,
  InviteCreateResult,
  InviteListParams,
  InvitePreview,
  Member,
  MemberListParams,
  OrgErrorEnvelope,
  OrgFieldError,
  OrgMe,
  PaginatedResult,
  PatchMemberRequest,
} from "@/types/org";

const KNOWN_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "ORG_CONTEXT_REQUIRED",
  "ORG_MEMBERSHIP_INACTIVE",
  "ORG_SUSPENDED",
  "ORG_ADMIN_REQUIRED",
  "ORG_MEMBER_NOT_FOUND",
  "ORG_MEMBER_LIMIT_REACHED",
  "ORG_LAST_ADMIN",
  "ORG_USER_ALREADY_MEMBER",
  "ORG_USER_HAS_CURRENT_ORG",
  "ORG_USER_CONFLICT",
  "ORG_CONCURRENT_MODIFICATION",
  "ORG_INVITE_UNAVAILABLE",
  "ORG_INVITE_ALREADY_EXISTS",
  "ORG_INVITE_TARGET_MISMATCH",
  "ORG_INVITE_ALREADY_USED",
  "ORG_IDEMPOTENCY_CONFLICT",
  "ORG_RATE_LIMITED",
  "ORG_REQUEST_INVALID",
  "ORG_INTERNAL_ERROR",
]);

const KNOWN_FIELD_ERROR_CODES = new Set([
  "invalid",
  "missing",
  "extra_forbidden",
  "literal_error",
  "string_type",
  "string_too_short",
  "string_too_long",
  "int_type",
  "int_parsing",
  "greater_than_equal",
  "less_than_equal",
  "list_type",
  "too_short",
  "too_long",
  "datetime_type",
  "datetime_parsing",
  "value_error",
]);

const FIELD_ERROR_PATH_SEGMENTS = new Set([
  "body",
  "query",
  "items",
  "mode",
  "user_id",
  "username",
  "password",
  "client_item_id",
  "role",
  "membership_status",
  "expected_updated_at",
  "target_username",
  "expires_in_hours",
  "status",
  "q",
  "sort",
  "dir",
  "limit",
  "offset",
]);

const MAX_FIELD_ERROR_PATH_LENGTH = 128;
const MAX_FIELD_ERROR_PATH_SEGMENTS = 8;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d{0,5})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFieldErrorPath(value: string): string {
  if (value.length === 0 || value.length > MAX_FIELD_ERROR_PATH_LENGTH) return "request";
  const segments = value.split(".");
  if (
    segments.length > MAX_FIELD_ERROR_PATH_SEGMENTS ||
    segments.some(
      (segment, index) =>
        !FIELD_ERROR_PATH_SEGMENTS.has(segment) &&
        (!ARRAY_INDEX_PATTERN.test(segment) || segments[index - 1] !== "items"),
    )
  ) {
    return "request";
  }
  return segments.join(".");
}

function safeFieldErrorCode(value: string): string {
  return KNOWN_FIELD_ERROR_CODES.has(value) ? value : "invalid";
}

function parseFieldErrors(value: unknown): OrgFieldError[] | null {
  if (!Array.isArray(value)) return null;
  const result: OrgFieldError[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.code !== "string" ||
      typeof item.message !== "string"
    ) {
      return null;
    }
    result.push({
      path: safeFieldErrorPath(item.path),
      code: safeFieldErrorCode(item.code),
      message: "Invalid value.",
    });
  }
  return result;
}

function parseErrorEnvelope(value: unknown): OrgErrorEnvelope | null {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) return null;
  const error = value.error;
  if (
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    typeof error.request_id !== "string"
  ) {
    return null;
  }
  const fieldErrors = parseFieldErrors(error.field_errors);
  return {
    ok: false,
    error: {
      code: error.code,
      message: "Organization request failed",
      request_id: REQUEST_ID_PATTERN.test(error.request_id) ? error.request_id : "",
      ...(fieldErrors ? { field_errors: fieldErrors } : {}),
    },
  };
}

export class OrgApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly fieldErrors: OrgFieldError[];

  constructor(values: {
    status: number | null;
    code?: string;
    requestId?: string | null;
    fieldErrors?: OrgFieldError[];
  }) {
    super("Organization request failed");
    this.name = "OrgApiError";
    this.status = values.status;
    this.code = values.code ?? "ORG_REQUEST_FAILED";
    this.requestId = values.requestId ?? null;
    this.fieldErrors = values.fieldErrors ?? [];
  }
}

async function responseBody(error: HTTPError): Promise<unknown> {
  const data = (error as HTTPError & { data?: unknown }).data;
  if (data !== undefined) return data;
  try {
    return await error.response.clone().json();
  } catch {
    return null;
  }
}

async function toOrgApiError(error: unknown): Promise<OrgApiError> {
  if (!(error instanceof HTTPError)) return new OrgApiError({ status: null });
  const envelope = parseErrorEnvelope(await responseBody(error));
  return new OrgApiError({
    status: error.response.status,
    code:
      envelope && KNOWN_ERROR_CODES.has(envelope.error.code)
        ? envelope.error.code
        : "ORG_REQUEST_FAILED",
    requestId: envelope?.error.request_id || null,
    fieldErrors: envelope?.error.field_errors ?? [],
  });
}

async function orgResponse(request: () => Promise<Response>): Promise<Response> {
  try {
    return await request();
  } catch (error) {
    throw await toOrgApiError(error);
  }
}

async function orgJson<T>(request: () => Promise<Response>): Promise<T> {
  const response = await orgResponse(request);
  try {
    return (await response.json()) as T;
  } catch {
    throw new OrgApiError({ status: response.status });
  }
}

function searchParams(values: object): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number") {
      result.set(key, String(value));
    }
  }
  return result;
}

function normalizeMemberListParams(params: MemberListParams): MemberListParams {
  const normalized: MemberListParams = {};
  if (typeof params.status === "string") normalized.status = params.status;
  if (typeof params.role === "string") normalized.role = params.role;
  if (typeof params.q === "string") normalized.q = params.q;
  if (typeof params.sort === "string") normalized.sort = params.sort;
  if (typeof params.dir === "string") normalized.dir = params.dir;
  if (typeof params.limit === "number") normalized.limit = params.limit;
  if (typeof params.offset === "number") normalized.offset = params.offset;
  return normalized;
}

function normalizeInviteListParams(params: InviteListParams): InviteListParams {
  const normalized: InviteListParams = {};
  if (typeof params.status === "string") normalized.status = params.status;
  if (typeof params.sort === "string") normalized.sort = params.sort;
  if (typeof params.dir === "string") normalized.dir = params.dir;
  if (typeof params.limit === "number") normalized.limit = params.limit;
  if (typeof params.offset === "number") normalized.offset = params.offset;
  return normalized;
}

const INVITE_FIELDS = new Set([
  "invite_id",
  "target_masked",
  "role",
  "status",
  "expires_at",
  "accepted_at",
  "created_at",
]);

function isDateTime(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value));
}

function isOptionalDateTime(value: unknown): boolean {
  return value === undefined || value === null || isDateTime(value);
}

function isInvite(value: unknown): value is Invite {
  if (!isRecord(value) || Object.keys(value).some((key) => !INVITE_FIELDS.has(key))) {
    return false;
  }
  return typeof value.invite_id === "string" &&
    value.invite_id.trim().length > 0 &&
    typeof value.target_masked === "string" &&
    value.target_masked.trim().length > 0 &&
    (value.role === undefined || value.role === "org_member") &&
    typeof value.status === "string" &&
    ["pending", "expired", "revoked", "accepted"].includes(value.status) &&
    isDateTime(value.expires_at) &&
    isOptionalDateTime(value.accepted_at) &&
    isOptionalDateTime(value.created_at);
}

function totalCount(response: Response): number {
  const raw = response.headers.get("X-Total-Count");
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new OrgApiError({ status: response.status });
  }
  const total = Number(raw);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new OrgApiError({ status: response.status });
  }
  return total;
}

function orgUrl(path: string): URL {
  return new URL(`/api/v1/org/${path}`, window.location.origin);
}

export function getOrgMe(): Promise<OrgMe> {
  return orgJson(() => api.get(orgUrl("me")));
}

async function listOrgMembersWithParams(
  params: MemberListParams,
): Promise<PaginatedResult<Member>> {
  const response = await orgResponse(() =>
    api.get(orgUrl("members"), { searchParams: searchParams(params) }),
  );
  try {
    return {
      items: (await response.json()) as Member[],
      total: totalCount(response),
    };
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw new OrgApiError({ status: response.status });
  }
}

export function listOrgMembers(
  params: MemberListParams = {},
): Promise<PaginatedResult<Member>> {
  return listOrgMembersWithParams(normalizeMemberListParams(params));
}

export function addOrgMember(
  request: IdempotentRequest<AddMemberRequest>,
): Promise<Member> {
  return orgJson(() =>
    api.post(orgUrl("members"), {
      json: request.body,
      headers: { "Idempotency-Key": request.idempotencyKey },
    }),
  );
}

export function addOrgMembersBatch(
  request: IdempotentRequest<BatchMembersRequest>,
): Promise<BatchMemberResult> {
  return orgJson(() =>
    api.post(orgUrl("members/batch"), {
      json: request.body,
      headers: { "Idempotency-Key": request.idempotencyKey },
    }),
  );
}

export function patchOrgMember(
  userId: string,
  body: PatchMemberRequest,
): Promise<Member> {
  return orgJson(() =>
    api.patch(orgUrl(`members/${encodeURIComponent(userId)}`), { json: body }),
  );
}

export interface CreateOrgInviteRequest
  extends IdempotentRequest<CreateInviteRequest> {
  consumeToken: (token: string | null) => void;
}

export async function createOrgInvite(
  request: CreateOrgInviteRequest,
): Promise<Invite> {
  const result = await orgJson<InviteCreateResult>(() =>
    api.post(orgUrl("invites"), {
      json: request.body,
      headers: { "Idempotency-Key": request.idempotencyKey },
    }),
  );
  request.consumeToken(result.token);
  return result.invite;
}

async function listOrgInvitesWithParams(
  params: InviteListParams,
): Promise<PaginatedResult<Invite>> {
  const response = await orgResponse(() =>
    api.get(orgUrl("invites"), { searchParams: searchParams(params) }),
  );
  try {
    const items: unknown = await response.json();
    if (!Array.isArray(items) || !items.every(isInvite)) {
      throw new OrgApiError({ status: response.status });
    }
    return {
      items,
      total: totalCount(response),
    };
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw new OrgApiError({ status: response.status });
  }
}

export function listOrgInvites(
  params: InviteListParams = {},
): Promise<PaginatedResult<Invite>> {
  return listOrgInvitesWithParams(normalizeInviteListParams(params));
}

export function revokeOrgInvite(inviteId: string): Promise<Invite> {
  return orgJson(() => api.delete(orgUrl(`invites/${encodeURIComponent(inviteId)}`)));
}

export function getOrgInvitePreview(token: string): Promise<InvitePreview> {
  return orgJson(() =>
    api.get(orgUrl(`invites/${encodeURIComponent(token)}/preview`)),
  );
}

export function acceptOrgInvite(
  token: string,
  request: IdempotentRequest<AcceptInviteRequest>,
): Promise<InviteAcceptResult> {
  return orgJson(() =>
    api.post(orgUrl(`invites/${encodeURIComponent(token)}/accept`), {
      json: request.body,
      headers: { "Idempotency-Key": request.idempotencyKey },
    }),
  );
}

export function useOrgMe() {
  return useQuery({
    queryKey: queryKeys.orgMe(),
    queryFn: getOrgMe,
    refetchOnWindowFocus: true,
  });
}

export function useOrgMembers(params: MemberListParams = {}) {
  const normalizedParams = normalizeMemberListParams(params);
  return useQuery({
    queryKey: queryKeys.orgMembersList(normalizedParams),
    queryFn: () => listOrgMembersWithParams(normalizedParams),
    refetchOnWindowFocus: true,
  });
}

export function useOrgInvites(params: InviteListParams = {}) {
  const normalizedParams = normalizeInviteListParams(params);
  return useQuery({
    queryKey: queryKeys.orgInvitesList(normalizedParams),
    queryFn: () => listOrgInvitesWithParams(normalizedParams),
    refetchOnWindowFocus: true,
  });
}

function useMemberMutation<TVariables, TData>(
  mutationFn: (values: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers() }),
      ]);
    },
  });
}

export function useAddOrgMember() {
  return useMemberMutation(addOrgMember);
}

export function useAddOrgMembersBatch() {
  return useMemberMutation(addOrgMembersBatch);
}

export function usePatchOrgMember() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: ({ userId, body }: { userId: string; body: PatchMemberRequest }) =>
      patchOrgMember(userId, body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites() }),
      ]);
    },
  });
}

export function useRevokeOrgInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeOrgInvite,
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites() }),
      ]);
    },
  });
}

export function useCreateOrgInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createOrgInvite,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites() }),
  });
}

export function useAcceptOrgInvite(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: IdempotentRequest<AcceptInviteRequest>) =>
      acceptOrgInvite(token, request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
  });
}
