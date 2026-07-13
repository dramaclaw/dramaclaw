// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { CharacterImageSourceSelect } from "@/components/assets/character-image-source-select";

const server = setupServer();
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          characters: {
            imageSource: {
              label: "Image source",
              loading: "Loading image source",
              saveFailed: "Failed to update image source",
            },
          },
        },
      },
    },
  });
  server.listen();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
}

describe("CharacterImageSourceSelect", () => {
  it("renders image source options from the project selection endpoint", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/image-source-selection/character",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              asset_kind: "character",
              image_source_selection: "identity",
              options: {
                portrait: "Character portrait",
                identity: "Identity image",
              },
            },
          }),
      ),
    );

    render(<CharacterImageSourceSelect project="demo" />, { wrapper });

    expect(await screen.findByText("Image source")).toBeInTheDocument();
    const trigger = await screen.findByRole("combobox", {
      name: "Image source",
    });
    expect(trigger).toHaveTextContent("Identity image");

    await user.click(trigger);

    expect(
      await screen.findByRole("option", { name: "Character portrait" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Identity image" }),
    ).toBeInTheDocument();
  });

  it("patches the selected image source when the user changes options", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    let currentSelection = "identity";
    let requestedPath = "";
    let patchBody: unknown = null;
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/image-source-selection/character",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              asset_kind: "character",
              image_source_selection: currentSelection,
              options: {
                portrait: "Character portrait",
                identity: "Identity image",
              },
            },
          }),
      ),
      http.patch(
        "http://localhost:3000/api/v1/projects/demo/image-source-selection/character",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          patchBody = await request.json();
          currentSelection = "portrait";
          return HttpResponse.json({
            ok: true,
            data: {
              asset_kind: "character",
              image_source_selection: currentSelection,
              options: {
                portrait: "Character portrait",
                identity: "Identity image",
              },
            },
          });
        },
      ),
    );

    render(
      <CharacterImageSourceSelect
        project="demo"
        onSelectionChange={onSelectionChange}
      />,
      { wrapper },
    );

    const trigger = await screen.findByRole("combobox", {
      name: "Image source",
    });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("option", { name: "Character portrait" }),
    );

    await waitFor(() => expect(patchBody).not.toBeNull());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/image-source-selection/character",
    );
    expect(patchBody).toEqual({ image_source_selection: "portrait" });
    expect(onSelectionChange).toHaveBeenCalledWith("portrait");
  });
});
