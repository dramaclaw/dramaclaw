// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

const taskControllerMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: (opts: unknown) => taskControllerMock(opts),
}));

const directorDialogPropsMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/viewer-kit/three-d/ThreeDDirectorDialog", () => ({
  ThreeDDirectorDialog: (props: any) => {
    directorDialogPropsMock(props);
    return props.open ? (
      <button
        type="button"
        onClick={() =>
          props.onSaveScene?.(
            {
              schemaVersion: 1,
              world: { activeSourceId: "scene-pano:Hall" },
              actors: [],
              props: [],
              stagings: [],
            },
            "scene-pano:Hall",
          )
        }
      >
        mock-save-scene-world
      </button>
    ) : null;
  },
}));

import { PropsPanel } from "@/components/assets/props-panel";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { ScenesPanel } from "@/components/assets/scenes-panel";
import { enTranslation } from "../../helpers/i18n-fixtures";

import {
  AssetHeaderActionsSlotProvider,
  AssetHeaderActionsTarget,
} from "@/components/assets/asset-header-actions-slot";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: enTranslation } },
    interpolation: { escapeValue: false },
  });
});

function idleTaskController() {
  return {
    started: false,
    stream: {
      status: "idle",
      progress: 0,
      currentTask: "",
      result: null,
      error: null,
      logs: [],
    },
    logs: [],
    start: vi.fn(),
    stop: vi.fn(),
    stopping: false,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  taskControllerMock.mockReset();
  taskControllerMock.mockImplementation(() => idleTaskController());
});

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <AssetHeaderActionsSlotProvider>
          <AssetHeaderActionsTarget />
          <ConfirmDialogHost />
          {ui}
        </AssetHeaderActionsSlotProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("asset panel rename behavior", () => {
  const renameWarning =
    "Changing the name changes the asset ID. Existing plans, storyboards, and generated results will not migrate automatically. You may need to plan and generate again after saving. Continue?";

  async function editAsset(kind: "scenes" | "props") {
    const original = kind === "scenes" ? "Hall" : "Sword";
    const requests = vi.fn();
    server.use(
      http.get(`http://localhost:3000/api/v1/projects/demo/${kind}`, () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: original, scene_type: "interior", prop_type: "weapon", description: "original description", visual_prompt: "silver sword" }],
        }),
      ),
      http.patch(`http://localhost:3000/api/v1/projects/demo/${kind}/${original}`, async ({ request }) => {
        const payload = await request.json();
        requests(payload);
        return HttpResponse.json({ ok: true, data: payload });
      }),
    );
    renderWithProviders(kind === "scenes" ? <ScenesPanel project="demo" /> : <PropsPanel project="demo" />);
    await screen.findAllByText(original);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    return { original, requests, name: screen.getByDisplayValue(original), form: screen.getByRole("dialog") };
  }

  describe.each(["scenes", "props"] as const)("%s rename confirmation", (kind) => {
    it("confirms a changed name before sending one update", async () => {
      const { original, requests, name, form } = await editAsset(kind);
      fireEvent.change(name, { target: { value: `${original}New` } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      const confirmation = await screen.findByRole("alertdialog");
      expect(within(confirmation).getByText(renameWarning)).toBeInTheDocument();
      expect(requests).not.toHaveBeenCalled();
      fireEvent.click(within(confirmation).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
      expect(requests).toHaveBeenCalledWith(expect.objectContaining({ name: `${original}New` }));
    });

    it.each(["cancel", "escape"])("preserves all inputs on %s, sends no update, and allows retry even with zero references", async (dismiss) => {
      const user = userEvent.setup();
      const { original, requests, name, form } = await editAsset(kind);
      fireEvent.change(name, { target: { value: `  ${original}New  ` } });
      const other = kind === "scenes" ? within(form).getByDisplayValue("original description") : within(form).getByDisplayValue("silver sword");
      fireEvent.change(other, { target: { value: "edited prompt or description" } });
      const save = within(form).getByRole("button", { name: "Save" });
      // These land in the same event turn, while mutation.isPending is false.
      fireEvent.click(save);
      fireEvent.click(save);
      const confirmation = await screen.findByRole("alertdialog");
      expect(within(confirmation).getByText(renameWarning)).toBeInTheDocument();
      expect(requests).not.toHaveBeenCalled();
      await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus());
      if (dismiss === "cancel") await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
      else await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(screen.getByRole("dialog")).toBe(form);
      expect(name).toHaveValue(`  ${original}New  `);
      expect(other).toHaveValue("edited prompt or description");
      expect(requests).not.toHaveBeenCalled();

      await user.click(save);
      const retry = await screen.findByRole("alertdialog");
      expect(requests).not.toHaveBeenCalled();
      await user.click(within(retry).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
      expect(requests).toHaveBeenCalledWith(expect.objectContaining({
        name: `${original}New`,
        [kind === "scenes" ? "description" : "visual_prompt"]: "edited prompt or description",
      }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it.each([false, true])("saves non-name edits without confirmation when surrounding whitespace=%s", async (spaces) => {
      const { original, requests, name, form } = await editAsset(kind);
      if (spaces) fireEvent.change(name, { target: { value: `  ${original}  ` } });
      const other = kind === "scenes" ? within(form).getByDisplayValue("original description") : within(form).getByDisplayValue("silver sword");
      fireEvent.change(other, { target: { value: "new details" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
      expect(requests).toHaveBeenCalledWith(expect.objectContaining({ name: original }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("unlocks a failed update so the user can retry confirmation", async () => {
      const { original, requests, name, form } = await editAsset(kind);
      let attempts = 0;
      server.use(http.patch(`http://localhost:3000/api/v1/projects/demo/${kind}/${original}`, async ({ request }) => {
        const payload = await request.json();
        requests(payload);
        return HttpResponse.json(++attempts === 1 ? { ok: false, error: "try again" } : { ok: true, data: payload });
      }));
      fireEvent.change(name, { target: { value: `${original}New` } });
      for (let attempt = 1; attempt <= 2; attempt++) {
        await userEvent.click(within(form).getByRole("button", { name: "Save" }));
        const confirmation = await screen.findByRole("alertdialog");
        await userEvent.click(within(confirmation).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(requests).toHaveBeenCalledTimes(attempt));
        if (attempt === 1) await waitFor(() => expect(within(form).getByRole("button", { name: "Save" })).not.toBeDisabled());
      }
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  it("confirms the composed scene variant name, retaining variant inputs after cancellation", async () => {
    const user = userEvent.setup();
    const requests = vi.fn();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () => HttpResponse.json({ ok: true, data: [
        { name: "Hall", scene_type: "interior" },
        { name: "Hall_漏水_夜晚", scene_type: "interior", base_scene_id: "Hall", variant_id: "漏水", time_of_day: "夜晚", variant_prompt: "water" },
      ] })),
      http.patch("http://localhost:3000/api/v1/projects/demo/scenes/:name", async ({ request, params }) => {
        expect(decodeURIComponent(String(params.name))).toBe("Hall_漏水_夜晚");
        const payload = await request.json(); requests(payload);
        return HttpResponse.json({ ok: true, data: payload });
      }),
    );
    renderWithProviders(<ScenesPanel project="demo" />);
    await screen.findByText("Hall_漏水_夜晚");
    const edits = screen.getAllByRole("button", { name: "Edit" });
    await user.click(edits[edits.length - 1]);
    const form = screen.getByRole("dialog");
    fireEvent.change(within(form).getByLabelText("Variant"), { target: { value: "  积雪  " } });
    await user.click(within(form).getByRole("button", { name: "Save" }));
    let confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText(renameWarning)).toBeInTheDocument();
    expect(requests).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(within(form).getByLabelText("Variant")).toHaveValue("  积雪  ");
    expect(within(form).getByText("Hall_积雪_夜晚")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ name: "Hall_积雪_夜晚", variant_id: "积雪", base_scene_id: "Hall", time_of_day: "夜晚" }));
  });


  it("confirms scene deletion through the styled dialog instead of window.confirm", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleted = false;
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "Hall", scene_type: "interior", environment_prompt: "wide hall" }],
        }),
      ),
      http.post("http://localhost:3000/api/v1/projects/demo/scenes/Hall/delete", () => {
        deleted = true;
        return HttpResponse.json({ ok: true, data: { deleted: true } });
      }),
    );

    renderWithProviders(
      <>
        <ScenesPanel project="demo" />
      </>,
    );

    expect(await screen.findAllByText("Hall")).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Delete scene "Hall"?')).toBeInTheDocument();
    // 走原生 confirm 的话对话框根本不会出现，删除也早就发出去了。
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deleted).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleted).toBe(true));
    nativeConfirm.mockRestore();
  });

  it("shows scene naming rules and submits the selected scene type as its canonical code", async () => {
    const user = userEvent.setup();
    let postBody: unknown = null;
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
      http.post("http://localhost:3000/api/v1/projects/demo/scenes", async ({ request }) => {
        postBody = await request.json();
        return HttpResponse.json({
          ok: true,
          data: { name: "Bathroom_Leak", scene_type: "exterior" },
        });
      }),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await user.click(await screen.findByRole("button", { name: "New scene" }));
    expect(
      screen.getByText(
        "For a standalone base scene, enter only the scene name. Add state or time versions from the selected scene's variant area.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Scene name"), {
      target: { value: "Bathroom_Leak" },
    });
    await user.click(screen.getByRole("combobox", { name: "Scene type" }));
    await user.click(await screen.findByRole("option", { name: "Exterior" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(postBody).toBeDefined());
    expect(postBody).toMatchObject({
      name: "Bathroom_Leak",
      scene_type: "exterior",
    });
  });

  it("renders extracted scene type codes as localized labels in the scene list", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "Hall", scene_type: "interior", environment_prompt: "" }],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    expect(await screen.findAllByText("Hall")).not.toHaveLength(0);
    expect(await screen.findByText("Interior")).toBeInTheDocument();
    expect(screen.queryByText("interior")).not.toBeInTheDocument();
  });

  it("shows derived scene base labels", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "Hall", scene_type: "interior", derived_from_scene: "" },
            {
              name: "Hall_Snow",
              scene_type: "interior",
              derived_from_scene: "Hall",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await screen.findByText("Hall_Snow");
    expect(screen.getByText("Derived from Hall")).toBeInTheDocument();
  });

  it("keeps scene variant groups compact without repeating a lower count label", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "Door", scene_type: "interior", environment_prompt: "" },
            { name: "Hall", scene_type: "interior", environment_prompt: "" },
            {
              name: "Hall_Night",
              scene_type: "interior",
              base_scene_id: "Hall",
              time_of_day: "夜晚",
              environment_prompt: "",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    expect(await screen.findAllByText("Door")).not.toHaveLength(0);
    expect(screen.queryByText("1 个场景变体")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select scene Hall" }));
    expect(screen.queryByText("2 个场景变体")).not.toBeInTheDocument();
  });

  it("uses a character-tab style split view for scene bases and selected variants", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "Door", scene_type: "interior", environment_prompt: "" },
            { name: "Hall", scene_type: "interior", environment_prompt: "" },
            {
              name: "Hall_Night",
              scene_type: "interior",
              base_scene_id: "Hall",
              time_of_day: "夜晚",
              environment_prompt: "",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    expect(await screen.findByRole("button", { name: "Select scene Door" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select scene Hall" })).toBeInTheDocument();
    expect(screen.queryByText("Hall_Night")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select scene Hall" }));

    expect(screen.getByText("Hall_Night")).toBeInTheDocument();
    expect(screen.queryByText("Door_上午")).not.toBeInTheDocument();
  });

  it("remembers the selected scene group after the scene panel unmounts", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "Door", scene_type: "interior", environment_prompt: "" },
            { name: "Hall", scene_type: "interior", environment_prompt: "" },
            {
              name: "Hall_Night",
              scene_type: "interior",
              base_scene_id: "Hall",
              time_of_day: "夜晚",
              environment_prompt: "",
            },
          ],
        }),
      ),
    );

    const firstRender = renderWithProviders(<ScenesPanel project="demo" />);

    await screen.findByRole("button", { name: "Select scene Door" });
    await user.click(screen.getByRole("button", { name: "Select scene Hall" }));
    expect(screen.getByText("Hall_Night")).toBeInTheDocument();

    firstRender.unmount();
    renderWithProviders(<ScenesPanel project="demo" />);

    await screen.findByRole("button", { name: "Select scene Door" });
    expect(screen.getByRole("button", { name: "Select scene Hall" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Hall_Night")).toBeInTheDocument();
  });

  it("keeps the new scene dialog focused on base scenes", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await user.click(await screen.findByRole("button", { name: "New scene" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByLabelText("Scene name")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("基础场景")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("变体")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("时间")).not.toBeInTheDocument();
  });

  it("creates scene variants from the selected base scene and stores only variant delta prompt", async () => {
    const user = userEvent.setup();
    let postBody: unknown = null;
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            {
              name: "Hall",
              scene_type: "interior",
              environment_prompt: "正面：wide hall\n光源：soft skylight",
              description: "base hall description",
            },
          ],
        }),
      ),
      http.post("http://localhost:3000/api/v1/projects/demo/scenes", async ({ request }) => {
        postBody = await request.json();
        return HttpResponse.json({
          ok: true,
          data: { name: "Hall_漏水_夜晚", scene_type: "interior" },
        });
      }),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await screen.findByRole("button", { name: "Select scene Hall" });
    await user.click(await screen.findByRole("button", { name: "Add scene variant" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Auto-generated after variant or time is set")).toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue("wide hall")).not.toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue("soft skylight")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Variant"), {
      target: { value: "漏水" },
    });
    fireEvent.change(within(dialog).getByLabelText("Variant delta prompt"), {
      target: { value: "floor water and dripping ceiling" },
    });
    await user.click(within(dialog).getByRole("combobox", { name: "Time" }));
    await user.click(await screen.findByRole("option", { name: "Night" }));
    expect(within(dialog).getByText("Hall_漏水_夜晚")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(postBody).toBeDefined());
    expect(postBody).toMatchObject({
      name: "Hall_漏水_夜晚",
      base_scene_id: "Hall",
      variant_id: "漏水",
      time_of_day: "夜晚",
      variant_prompt: "floor water and dripping ceiling",
      description: "",
    });
    expect(String((postBody as { environment_prompt?: string }).environment_prompt)).not.toContain(
      "wide hall",
    );
  });

  it("allows graph scene rebuild when derived scenes exist", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "Hall", scene_type: "interior", derived_from_scene: "" },
            {
              name: "Hall_Snow",
              scene_type: "interior",
              derived_from_scene: "Hall",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await screen.findByText("Hall_Snow");
    const buildButton = screen.getByRole("button", { name: "Build from graph" });
    expect(buildButton).not.toBeDisabled();
    expect(buildButton).not.toHaveAttribute("title");
  });


  it("shows the NiceGUI prop type select label in the edit dialog", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "TOKEN", prop_type: "artifact", visual_prompt: "digital token" }],
        }),
      ),
    );

    renderWithProviders(<PropsPanel project="demo" />);

    await screen.findByText("TOKEN");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Artifact")).toBeInTheDocument();
  });


  it("saves the asset scene Director World snapshot to the scene-level endpoint", async () => {
    const user = userEvent.setup();
    let saveBody: unknown = null;
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            {
              name: "Hall",
              scene_type: "interior",
              pano_url: "/static/projects/demo/director_worlds/Hall/v1/pano_360.png",
              stage_3gs: {
                active_source: "",
                active: { ready: false, size_mb: 0 },
                custom: { ready: false },
                master: { ready: false },
                reverse: { ready: false },
                pano: { ready: true, size_mb: 7.7 },
              },
            },
          ],
        }),
      ),
      http.get(
        "http://localhost:3000/api/v1/projects/demo/scenes/Hall/director-stage/manifest",
        () =>
          HttpResponse.json({
            ok: false,
            error: "no 3gs",
          }),
      ),
      http.post(
        "http://localhost:3000/api/v1/projects/demo/scenes/Hall/director-stage/world",
        async ({ request }) => {
          saveBody = await request.json();
          return HttpResponse.json({
            ok: true,
            data: {
              active_source_id: "scene-pano:Hall",
              scenes_by_source_id: {},
            },
          });
        },
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    expect(await screen.findAllByText("Hall")).not.toHaveLength(0);
    const openWorldButtons = await screen.findAllByRole("button", {
      name: "Open Director World",
    });
    await user.click(openWorldButtons[openWorldButtons.length - 1]);
    await user.click(await screen.findByRole("button", { name: "mock-save-scene-world" }));

    await waitFor(() => expect(saveBody).toBeDefined());
    expect(saveBody).toMatchObject({
      active_source_id: "scene-pano:Hall",
      snapshot: { world: { activeSourceId: "scene-pano:Hall" } },
    });
    expect(screen.queryByText(/当前导演世界/)).not.toBeInTheDocument();
  });

});
