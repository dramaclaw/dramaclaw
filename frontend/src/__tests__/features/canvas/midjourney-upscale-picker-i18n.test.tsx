import { readFileSync } from "node:fs";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MidjourneyUpscalePicker } from "@/features/canvas/ui/MidjourneyUpscalePicker";

describe("Midjourney quadrant translations", () => {
  it.each([
    [
      "en",
      "Upscale U2",
      "View U1 HD image",
      "Select U2",
      "Estimated credits: 3",
    ],
    ["zh", "放大 U2", "查看 U1 高清图", "选择 U2", "预计积分：3"],
    ["vi", "Phóng to U2", "Xem ảnh HD U1", "Chọn U2", "Điểm dự kiến: 3"],
  ])(
    "renders real %s resources and switches to English without Chinese fallback",
    async (language, upscale, view, select, cost) => {
      const i18n = i18next.createInstance();
      const resources = Object.fromEntries(
        ["en", "zh", "vi"].map((locale) => [
          locale,
          {
            translation: JSON.parse(
              readFileSync(`public/locales/${locale}/translation.json`, "utf8"),
            ),
          },
        ]),
      );
      await i18n.use(initReactI18next).init({
        lng: language,
        fallbackLng: false,
        resources,
        interpolation: { escapeValue: false },
      });
      for (const key of [
        "selectUpscaleCandidate",
        "confirmUpscale",
        "viewUpscale",
        "upscaleCached",
        "upscaleCost",
        "upscaleConfirmHint",
      ]) {
        expect(i18n.exists(`node.imageGen.${key}`)).toBe(true);
      }
      const onAction = vi.fn();
      const { container, rerender } = render(
        <I18nextProvider i18n={i18n}>
          <MidjourneyUpscalePicker
            candidates={[
              { index: 1, label: "U1", customId: "one" },
              { index: 2, label: "U2", customId: "two" },
            ]}
            results={{ one: "/cached.png" }}
            onAction={onAction}
            costLabel="3"
          />
        </I18nextProvider>,
      );
      expect(screen.getByRole("button", { name: view })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: upscale })).toHaveAttribute(
        "title",
        cost,
      );
      fireEvent.click(screen.getByRole("button", { name: select }));
      expect(screen.getByLabelText(cost)).toHaveTextContent("3");
      expect(screen.getByRole("button", { name: upscale }).textContent).toBe(
        upscale.replace(/ U2$/, ""),
      );
      expect(onAction).not.toHaveBeenCalled();
      await act(async () => {
        await i18n.changeLanguage("en");
      });
      expect(
        screen.getByRole("button", { name: "Upscale U2" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "View U1 HD image" }),
      ).toHaveAttribute(
        "title",
        "HD image available; no additional credits charged",
      );
      expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
      rerender(
        <I18nextProvider i18n={i18n}>
          <MidjourneyUpscalePicker
            candidates={[{ index: 2, label: "U2", customId: "two" }]}
            results={{}}
            onAction={onAction}
          />
        </I18nextProvider>,
      );
      expect(
        screen.getByRole("button", { name: "Upscale U2" }),
      ).toHaveAttribute("title", "Upscaling uses credits");
    },
  );
});
