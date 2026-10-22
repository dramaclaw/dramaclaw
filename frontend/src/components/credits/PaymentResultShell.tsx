// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from "react";

export function PaymentResultShell({
  back,
  children,
}: {
  back: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      {back}
      <section className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 pb-20 text-center">
        {children}
      </section>
    </div>
  );
}
