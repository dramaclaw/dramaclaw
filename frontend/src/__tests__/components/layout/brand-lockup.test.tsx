// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrandLockup } from "@/components/layout/brand-lockup";

const urlA = "/assets/org-brand/sha256/ab/cd/" + "abcd" + "a".repeat(60) + ".png";
const urlB = "/assets/org-brand/sha256/12/34/" + "1234" + "b".repeat(60) + ".webp";

function branding(url: string) {
  return {
    schema_version: 1 as const,
    organization: { org_id: "org-1", name: "Claymore" },
    branding: { logo_url: url, updated_at: "2026-08-21T10:00:00Z" },
  };
}

describe("BrandLockup", () => {
  it("always shows DramaClaw and renders organization branding only at xl", () => {
    const { container } = render(<BrandLockup value={branding(urlA)} />);
    expect(container.querySelector('img[src="/brand/dramaclaw-wordmark.png"]')).not.toBeNull();
    const organization = screen.getByTestId("organization-brand");
    const logo = organization.querySelector("img");
    expect(logo).toHaveAttribute("src", urlA);
    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveClass("h-[22px]", "max-w-[96px]");
    expect(organization).toHaveClass("hidden", "xl:flex");
  });

  it("hides the organization section on image error and remounts for a new URL", () => {
    const onOrganizationBrandError = vi.fn();
    const { rerender } = render(
      <BrandLockup
        value={branding(urlA)}
        onOrganizationBrandError={onOrganizationBrandError}
      />,
    );
    fireEvent.error(screen.getByTestId("organization-brand").querySelector("img")!);
    expect(screen.queryByTestId("organization-brand")).toBeNull();
    expect(onOrganizationBrandError).toHaveBeenCalledWith(urlA);

    rerender(
      <BrandLockup
        value={branding(urlB)}
        onOrganizationBrandError={onOrganizationBrandError}
      />,
    );
    expect(screen.getByTestId("organization-brand").querySelector("img")).toHaveAttribute(
      "src",
      urlB,
    );
    expect(screen.getByTestId("organization-brand")).toBeInTheDocument();
  });

  it("shows no separator when branding is absent", () => {
    render(<BrandLockup value={null} />);
    expect(screen.queryByTestId("organization-brand")).toBeNull();
  });
});
