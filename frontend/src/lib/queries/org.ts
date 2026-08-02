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
  GatewayKeyStatus,
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
  "ORG_CREDENTIAL_VERSION_MISMATCH",
  "ORG_CREDENTIAL_INTERNAL_ERROR",
  "ORG_KEY_VALIDATION_FAILED",
  "ORG_KEY_VALIDATION_UNAVAILABLE",
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

const ORG_ME_FIELDS = new Set([
  "user",
  "organization",
  "membership",
  "capabilities",
  "gateway_key",
  "denial_reason",
]);
const ORG_ME_USER_FIELDS = new Set([
  "user_id",
  "username",
  "model_billing_entitlement",
]);
const ORG_ME_ORGANIZATION_FIELDS = new Set([
  "org_id",
  "name",
  "status",
  "updated_at",
]);
const ORG_ME_MEMBERSHIP_FIELDS = new Set([
  "role",
  "membership_status",
  "updated_at",
]);
const ORG_CAPABILITY_FIELDS = new Set([
  "manage_members",
  "manage_invites",
  "manage_gateway_key",
  "start_model_tasks",
]);
const ORG_GATEWAY_SUMMARY_FIELDS = new Set(["state", "key_version"]);
const ORG_ACCESS_DENIAL_REASONS = new Set([
  "MODEL_ACCESS_DENIED",
  "ORG_MEMBERSHIP_INACTIVE",
  "ORG_SUSPENDED",
  "ORG_CREDENTIAL_MISSING",
  "ORG_CREDENTIAL_DISABLED",
  "ORG_AUTHZ_STALE",
]);

function hasExactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOrgMeUser(value: unknown): boolean {
  return isRecord(value) &&
    hasExactFields(value, ORG_ME_USER_FIELDS) &&
    isNonEmptyString(value.user_id) &&
    isNonEmptyString(value.username) &&
    ["platform", "org_sponsored", "disabled"].includes(
      String(value.model_billing_entitlement),
    );
}

function isOrgMeOrganization(value: unknown): boolean {
  return value === null || (
    isRecord(value) &&
    hasExactFields(value, ORG_ME_ORGANIZATION_FIELDS) &&
    isNonEmptyString(value.org_id) &&
    isNonEmptyString(value.name) &&
    ["active", "suspended"].includes(String(value.status)) &&
    (value.updated_at === null || isGatewayZonedDateTime(value.updated_at))
  );
}

function isOrgMeMembership(value: unknown): boolean {
  return value === null || (
    isRecord(value) &&
    hasExactFields(value, ORG_ME_MEMBERSHIP_FIELDS) &&
    ["org_admin", "org_member"].includes(String(value.role)) &&
    ["active", "suspended"].includes(String(value.membership_status)) &&
    (value.updated_at === null || isGatewayZonedDateTime(value.updated_at))
  );
}

function isOrgCapabilities(value: unknown): boolean {
  return isRecord(value) &&
    hasExactFields(value, ORG_CAPABILITY_FIELDS) &&
    [...ORG_CAPABILITY_FIELDS].every((field) => typeof value[field] === "boolean");
}

function isGatewayKeySummary(value: unknown): boolean {
  return isRecord(value) &&
    hasExactFields(value, ORG_GATEWAY_SUMMARY_FIELDS) &&
    hasCoherentGatewayStateVersion(value.state, value.key_version);
}

function parseOrgMe(value: unknown, status: number): OrgMe {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ORG_ME_FIELDS) ||
    !isOrgMeUser(value.user) ||
    !isOrgMeOrganization(value.organization) ||
    !isOrgMeMembership(value.membership) ||
    !isOrgCapabilities(value.capabilities) ||
    !isGatewayKeySummary(value.gateway_key) ||
    !(value.denial_reason === null ||
      (typeof value.denial_reason === "string" &&
        ORG_ACCESS_DENIAL_REASONS.has(value.denial_reason)))
  ) {
    throw new OrgApiError({ status });
  }
  const capabilities = value.capabilities as Record<string, unknown>;
  const canStart = capabilities.start_model_tasks === true;
  if (canStart !== (value.denial_reason === null)) {
    throw new OrgApiError({ status });
  }
  return value as unknown as OrgMe;
}

async function orgMeJson(request: () => Promise<Response>): Promise<OrgMe> {
  const response = await orgResponse(request);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new OrgApiError({ status: response.status });
  }
  return parseOrgMe(value, response.status);
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

const GATEWAY_STATUS_FIELDS = new Set([
  "state",
  "key_version",
  "verified_at",
  "updated_at",
]);
const GATEWAY_ZONED_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isGatewayZonedDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = GATEWAY_ZONED_DATETIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  return year >= 1 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    Number.isFinite(Date.parse(value));
}

function hasCoherentGatewayStateVersion(state: unknown, version: unknown): boolean {
  if (state === "never_configured") return version === null;
  if (state === "active" || state === "no_active") {
    return Number.isSafeInteger(version) && Number(version) > 0;
  }
  return false;
}

function parseGatewayKeyStatus(value: unknown, status: number): GatewayKeyStatus {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== GATEWAY_STATUS_FIELDS.size ||
    Object.keys(value).some((key) => !GATEWAY_STATUS_FIELDS.has(key)) ||
    !hasCoherentGatewayStateVersion(value.state, value.key_version) ||
    !(value.verified_at === null || isGatewayZonedDateTime(value.verified_at)) ||
    !(value.updated_at === null || isGatewayZonedDateTime(value.updated_at))
  ) {
    throw new OrgApiError({ status });
  }
  return value as unknown as GatewayKeyStatus;
}

async function gatewayStatusJson(
  request: () => Promise<Response>,
): Promise<GatewayKeyStatus> {
  const response = await orgResponse(request);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new OrgApiError({ status: response.status });
  }
  return parseGatewayKeyStatus(value, response.status);
}

function assertGatewayPutInput(
  expectedKeyVersion: number | null,
  idempotencyKey: string,
): void {
  if (
    !(expectedKeyVersion === null ||
      (Number.isSafeInteger(expectedKeyVersion) && expectedKeyVersion > 0)) ||
    idempotencyKey.trim().length === 0
  ) {
    throw new OrgApiError({ status: null });
  }
}

function assertGatewayDeleteInput(
  expectedKeyVersion: number,
  idempotencyKey: string,
): void {
  if (
    !Number.isSafeInteger(expectedKeyVersion) ||
    expectedKeyVersion <= 0 ||
    idempotencyKey.trim().length === 0
  ) {
    throw new OrgApiError({ status: null });
  }
}

export function getOrgGatewayKeyStatus(): Promise<GatewayKeyStatus> {
  return gatewayStatusJson(() => api.get(orgUrl("gateway/key/status")));
}

export function putOrgGatewayKey(
  gatewayKey: string,
  expectedKeyVersion: number | null,
  idempotencyKey: string,
): Promise<GatewayKeyStatus> {
  const normalizedKey = gatewayKey.trim();
  assertGatewayPutInput(expectedKeyVersion, idempotencyKey);
  if (normalizedKey.length === 0 || normalizedKey.length > 65_536) {
    throw new OrgApiError({ status: null });
  }
  return gatewayStatusJson(() =>
    api.put(orgUrl("gateway/key"), {
      retry: 0,
      json: {
        gateway_key: normalizedKey,
        expected_key_version: expectedKeyVersion,
      },
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  );
}

export function deleteOrgGatewayKey(
  expectedKeyVersion: number,
  idempotencyKey: string,
): Promise<GatewayKeyStatus> {
  assertGatewayDeleteInput(expectedKeyVersion, idempotencyKey);
  return gatewayStatusJson(() =>
    api.delete(orgUrl("gateway/key"), {
      retry: 0,
      json: { expected_key_version: expectedKeyVersion },
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  );
}

export function getOrgMe(): Promise<OrgMe> {
  return orgMeJson(() => api.get(orgUrl("me")));
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

export function useOrgGatewayKeyStatus() {
  return useQuery({
    queryKey: queryKeys.orgGatewayKey(),
    queryFn: getOrgGatewayKeyStatus,
    refetchOnWindowFocus: true,
    retry: false,
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
