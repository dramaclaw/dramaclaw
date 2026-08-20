// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { ProjectStyleChip } from "@/components/assets/project-style-chip";

const i18n = i18next.createInstance();
const server = setupServer();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          characters: {
            projectStyle: {
              label: "风格",
              configureHint: "在导入页面配置项目风格",
              loading: "读取风格",
            },
          },
          ingest: {
            visualStyles: {
              chinesePeriodDrama: "中式古装剧",
              guomanFantasy: "3D玄幻国漫",
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

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("ProjectStyleChip", () => {
  it("renders the project visual style label from the styles endpoint", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo", () =>
        HttpResponse.json({
          ok: true,
          data: { visual_style: "cyber_ink" },
        }),
      ),
      http.get("http://localhost:3000/api/v1/styles", ({ request }) => {
        expect(new URL(request.url).searchParams.get("project")).toBe("demo");
        return HttpResponse.json({
          ok: true,
          data: [{ id: "cyber_ink", name: "Cyber Ink", label: "赛博水墨" }],
        });
      }),
    );

    renderWithProviders(<ProjectStyleChip project="demo" />);

    expect(await screen.findByText("赛博水墨")).toBeInTheDocument();
    expect(screen.getByLabelText("赛博水墨")).toHaveAttribute(
      "title",
      "在导入页面配置项目风格",
    );
  });

  it("falls back to the built-in visual style label when styles are not loaded", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo", () =>
        HttpResponse.json({
          ok: true,
          data: { visual_style: "chinese_period_drama" },
        }),
      ),
      http.get("http://localhost:3000/api/v1/styles", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
    );

    renderWithProviders(<ProjectStyleChip project="demo" />);

    expect(await screen.findByText("中式古装剧")).toBeInTheDocument();
  });

  it("falls back to the built-in guoman fantasy label when styles are not loaded", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo", () =>
        HttpResponse.json({
          ok: true,
          data: { visual_style: "guoman_fantasy" },
        }),
      ),
      http.get("http://localhost:3000/api/v1/styles", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
    );

    renderWithProviders(<ProjectStyleChip project="demo" />);

    expect(await screen.findByText("3D玄幻国漫")).toBeInTheDocument();
  });
});
