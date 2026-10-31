// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import { SubscriptionAgreementPage } from "@/components/credits/SubscriptionAgreementPage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  server.resetHandlers();
  vi.restoreAllMocks();
});
function mount(version = "1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <SubscriptionAgreementPage agreementId="terms" version={version} />
    </QueryClientProvider>,
  );
}
it("reads the exact published version without an authenticated session and renders body safely", async () => {
  server.use(
    http.get(
      "*/api/v1/payments/subscriptions/agreements/terms/versions/1",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        return HttpResponse.json({
          ok: true,
          data: {
            agreement_id: "terms",
            version: 1,
            title: "Published subscription terms",
            body: "<script>window.bad=true</script>\nPlain service text.",
            effective_at: "2020-01-01T00:00:00Z",
          },
        });
      },
    ),
  );
  mount();
  await screen.findByRole("heading", { name: "Published subscription terms" });
  expect(screen.getByText(/<script>/)).toBeInTheDocument();
  expect(document.querySelector("article script")).toBeNull();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
it("shows an unavailable version without redirecting to login", async () => {
  server.use(
    http.get(
      "*/api/v1/payments/subscriptions/agreements/terms/versions/1",
      () => HttpResponse.json({}, { status: 404 }),
    ),
  );
  mount();
  await screen.findByRole("heading", {
    name: "subscriptionAgreementPage.unavailable",
  });
});
it("rejects malformed version paths without sending a request", async () => {
  mount("../draft");
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

it("provides a subscription link when a directly opened agreement has no application referrer", () => {
  vi.spyOn(window.history, "length", "get").mockReturnValue(2);
  vi.spyOn(document, "referrer", "get").mockReturnValue("");
  mount("../draft");
  expect(
    screen.getByRole("link", {
      name: "subscriptionAgreementPage.backToSubscriptions",
    }),
  ).toHaveAttribute("href", "/credits");
});

it("returns to the previous page when the agreement has navigation history", () => {
  vi.spyOn(window.history, "length", "get").mockReturnValue(2);
  vi.spyOn(document, "referrer", "get").mockReturnValue(
    `${window.location.origin}/checkout`,
  );
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  mount("../draft");
  fireEvent.click(
    screen.getByRole("link", { name: "subscriptionAgreementPage.back" }),
  );
  expect(back).toHaveBeenCalledOnce();
});
