// SPDX-License-Identifier: Elastic-2.0
import { useQuery } from "@tanstack/react-query";
import ky from "ky";

export interface PublishedSubscriptionAgreement {
  agreement_id: string;
  version: number;
  title: string;
  body: string;
  effective_at: string;
  published_at: string;
  content_hash: string;
}

export function useSubscriptionAgreement(agreementId: string, version: string) {
  const valid =
    /^[A-Za-z0-9_-]{1,128}$/.test(agreementId) &&
    /^[1-9]\d{0,8}$/.test(version);
  const query = useQuery({
    queryKey: ["subscription-agreement", agreementId, version],
    // The exact published text is public and immutable for this version.
    queryFn: () =>
      ky
        .get(
          new URL(
            `/api/v1/payments/subscriptions/agreements/${encodeURIComponent(agreementId)}/versions/${version}`,
            window.location.origin,
          ).href,
          { credentials: "include", retry: 0 },
        )
        .json<{ ok: true; data: PublishedSubscriptionAgreement }>(),
    enabled: valid,
    retry: false,
    staleTime: Infinity,
  });
  return { ...query, valid };
}
