// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { useAuthStore, type CurrentUser } from "@/stores/auth-store";
import type { OkResponse } from "@/types/api";

export interface AccountSecurity {
  password_configured: boolean;
  phone_masked: string | null;
}

export function useCurrentUser(enabled = true) {
  return useQuery({
    queryKey: queryKeys.currentUser(),
    queryFn: async (): Promise<OkResponse<CurrentUser>> => {
      const user = await useAuthStore.getState().getCurrentUser({
        clearOnNetworkFailure: false,
      });
      if (!user) {
        throw new Error("Not authenticated");
      }
      return { ok: true, data: user };
    },
    enabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAccountSecurity(enabled = true) {
  return useQuery({
    queryKey: queryKeys.accountSecurity(),
    queryFn: async (): Promise<AccountSecurity> => {
      const response = await fetch("/api/v1/account/security", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Account security unavailable");
      const body = (await response.json()) as OkResponse<AccountSecurity>;
      return body.data;
    },
    enabled,
    staleTime: 30_000,
  });
}
