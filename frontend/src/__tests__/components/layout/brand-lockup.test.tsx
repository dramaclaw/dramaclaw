// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandLockup } from "@/components/layout/brand-lockup";

const logoUrl = "/assets/org-brand/org-1/logo";

function branding(updatedAt: string) {
  return {
    schema_version: 1 as const,
    organization: { org_id: "org-1", name: "Claymore" },
    branding: { logo_url: logoUrl, updated_at: updatedAt },
  };
}

describe("BrandLockup", () => {
  it("always shows DramaClaw and renders organization branding only at xl", () => {
    const { container } = render(<BrandLockup value={branding("2026-08-21T10:00:00Z")} />);
    expect(container.querySelector('img[src="/brand/dramaclaw-wordmark.png"]')).not.toBeNull();
    const organization = screen.getByTestId("organization-brand");
    const logo = organization.querySelector("img");
    expect(logo).toHaveAttribute("src", logoUrl);
    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveClass("h-[22px]", "max-w-[96px]");
    expect(organization).toHaveClass("hidden", "xl:flex");
  });

  it("hides on image error and remounts when updated_at changes", () => {
    const { rerender } = render(
      <BrandLockup value={branding("2026-08-21T10:00:00Z")} />,
    );
    fireEvent.error(screen.getByTestId("organization-brand").querySelector("img")!);
    expect(screen.queryByTestId("organization-brand")).toBeNull();

    rerender(
      <BrandLockup value={branding("2026-08-21T10:01:00Z")} />,
    );
    expect(screen.getByTestId("organization-brand").querySelector("img")).toHaveAttribute(
      "src",
      logoUrl,
    );
    expect(screen.getByTestId("organization-brand")).toBeInTheDocument();
  });

  it("shows no separator when branding is absent", () => {
    render(<BrandLockup value={null} />);
    expect(screen.queryByTestId("organization-brand")).toBeNull();
  });
});
