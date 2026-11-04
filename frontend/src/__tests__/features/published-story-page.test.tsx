import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PublishedStoryPage } from "@/routes/play.$publicId.lazy";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute: () => () => ({}),
}));
const release = {
  public_id: "work",
  version: "v2",
  title: "Rain",
  description: "A choice",
  cover: null,
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});
it("distinguishes unavailable work from a retryable connection failure", async () => {
  mocks.fetch
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({ ok: true, json: async () => release });
  render(<PublishedStoryPage publicId="work" />);
  await screen.findByText("storyPublication.networkError");
  fireEvent.click(screen.getByText("storyPublication.retry"));
  await screen.findByRole("heading", { name: "Rain" });
});
it("keeps fresh-start available when the saved version cannot load", async () => {
  localStorage.setItem("dramaclaw.player.version.work", "v1");
  localStorage.setItem("dramaclaw.player.save.work.v1", "save");
  mocks.fetch
    .mockResolvedValueOnce({ ok: true, json: async () => release })
    .mockResolvedValueOnce({ ok: false, status: 410 });
  render(<PublishedStoryPage publicId="work" />);
  fireEvent.click(await screen.findByText("storyPublication.continue"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "storyPublication.resumeFailed",
    ),
  );
  expect(screen.getByText("storyPublication.startFresh")).toBeEnabled();
  expect(mocks.fetch.mock.calls[1][0]).toContain("/versions/v1");
});

it("shows the work and start action without creator metadata", async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...release, number: 6 }) });
  render(<PublishedStoryPage publicId="work" />);
  await screen.findByRole("heading", { name: "Rain" });
  expect(screen.getByText("A choice")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "storyPublication.start" })).toBeEnabled();
  expect(screen.queryByText("storyPublication.localSaveHint")).not.toBeInTheDocument();
  expect(screen.queryByText("storyPublication.liveVersion")).not.toBeInTheDocument();
  expect(screen.queryByText("DramaClaw")).not.toBeInTheDocument();
});
