/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NotificationWebhookSection,
  buildWebhookPatch,
  type NotificationWebhookSectionProps,
} from "../../src/components/NotificationWebhookSection";

function makeProps(overrides: Partial<NotificationWebhookSectionProps> = {}): NotificationWebhookSectionProps {
  return {
    initialWebhookUrl: null,
    hasSecret: false,
    urlDraft: "",
    onUrlDraftChange: vi.fn(),
    secretDraft: null,
    onSecretDraftChange: vi.fn(),
    ...overrides,
  };
}

describe("NotificationWebhookSection rendering", () => {
  it("renders the URL input and the empty secret input when no value is set", () => {
    render(<NotificationWebhookSection {...makeProps()} />);
    expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Signing secret (optional)")).toBeInTheDocument();
    expect(screen.queryByTestId("notification-webhook-secret-redacted")).not.toBeInTheDocument();
  });

  it("renders the URL value from draft", () => {
    render(
      <NotificationWebhookSection
        {...makeProps({ urlDraft: "https://hooks.example/inbox", initialWebhookUrl: "https://hooks.example/inbox" })}
      />,
    );
    expect(screen.getByLabelText("Webhook URL")).toHaveValue("https://hooks.example/inbox");
  });

  it("shows the redacted secret state when hasSecret is true and the operator has not clicked Replace", () => {
    render(<NotificationWebhookSection {...makeProps({ hasSecret: true })} />);
    expect(screen.getByTestId("notification-webhook-secret-redacted")).toHaveTextContent("•••• (set)");
    expect(screen.queryByLabelText("Signing secret (optional)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
  });

  it("switches from redacted state to an input when Replace is clicked", async () => {
    const onSecretDraftChange = vi.fn();
    render(<NotificationWebhookSection {...makeProps({ hasSecret: true, onSecretDraftChange })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Replace" }));
    // Parent transitions secretDraft from null → "", which would re-render the
    // component with the input visible. We assert the callback was made with the
    // expected value.
    expect(onSecretDraftChange).toHaveBeenCalledWith("");
  });

  it("when hasSecret + secretDraft is '' (Replace already clicked), renders the input plus a Cancel affordance", () => {
    const onSecretDraftChange = vi.fn();
    render(
      <NotificationWebhookSection
        {...makeProps({ hasSecret: true, secretDraft: "", onSecretDraftChange })}
      />,
    );
    expect(screen.getByLabelText("Signing secret (optional)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel secret replacement" })).toBeInTheDocument();
  });

  it("Cancel reverts secretDraft to null so the redacted state will re-appear on next render", async () => {
    const onSecretDraftChange = vi.fn();
    render(
      <NotificationWebhookSection
        {...makeProps({ hasSecret: true, secretDraft: "typed-so-far", onSecretDraftChange })}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel secret replacement" }));
    expect(onSecretDraftChange).toHaveBeenCalledWith(null);
  });
});

describe("NotificationWebhookSection — reveal toggle", () => {
  it("toggles the secret input type between password and text", async () => {
    render(<NotificationWebhookSection {...makeProps({ hasSecret: false, secretDraft: "shh" })} />);
    const input = screen.getByLabelText("Signing secret (optional)") as HTMLInputElement;
    expect(input.type).toBe("password");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show signing secret" }));
    expect(input.type).toBe("text");

    await user.click(screen.getByRole("button", { name: "Hide signing secret" }));
    expect(input.type).toBe("password");
  });

  it("never allows the browser to autocomplete the secret field", () => {
    render(<NotificationWebhookSection {...makeProps({ secretDraft: "" })} />);
    expect(screen.getByLabelText("Signing secret (optional)")).toHaveAttribute("autocomplete", "off");
  });
});

describe("NotificationWebhookSection — input types", () => {
  it("renders the webhook URL field as type='url' so the browser validates it", () => {
    render(<NotificationWebhookSection {...makeProps()} />);
    expect(screen.getByLabelText("Webhook URL")).toHaveAttribute("type", "url");
  });
});

describe("NotificationWebhookSection — change callbacks", () => {
  it("emits onUrlDraftChange on every keystroke", async () => {
    const onUrlDraftChange = vi.fn();
    render(<NotificationWebhookSection {...makeProps({ onUrlDraftChange })} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Webhook URL"), "x");
    expect(onUrlDraftChange).toHaveBeenLastCalledWith("x");
  });

  it("emits onSecretDraftChange on secret keystrokes in the input-visible state", async () => {
    const onSecretDraftChange = vi.fn();
    render(
      <NotificationWebhookSection {...makeProps({ secretDraft: "", onSecretDraftChange })} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Signing secret (optional)"), "s");
    expect(onSecretDraftChange).toHaveBeenLastCalledWith("s");
  });
});

describe("buildWebhookPatch", () => {
  it("omits both fields when nothing changed (no-op save)", () => {
    expect(
      buildWebhookPatch({
        initialWebhookUrl: "https://hooks.example",
        urlDraft: "https://hooks.example",
        secretDraft: null,
      }),
    ).toEqual({});
  });

  it("sends the trimmed URL when it changed", () => {
    expect(
      buildWebhookPatch({
        initialWebhookUrl: null,
        urlDraft: "  https://new.example  ",
        secretDraft: null,
      }),
    ).toEqual({ notificationWebhookUrl: "https://new.example" });
  });

  it("clears the URL when the operator empties the field", () => {
    expect(
      buildWebhookPatch({
        initialWebhookUrl: "https://old.example",
        urlDraft: "",
        secretDraft: null,
      }),
    ).toEqual({ notificationWebhookUrl: null });
  });

  it("sets the secret when the draft is a non-empty string", () => {
    expect(
      buildWebhookPatch({
        initialWebhookUrl: null,
        urlDraft: "",
        secretDraft: "topsecret",
      }),
    ).toEqual({ notificationWebhookSecret: "topsecret" });
  });

  it("clears the secret when the draft is empty string", () => {
    expect(
      buildWebhookPatch({
        initialWebhookUrl: null,
        urlDraft: "",
        secretDraft: "",
      }),
    ).toEqual({ notificationWebhookSecret: null });
  });

  it("leaves the secret untouched when draft is null (operator did not engage)", () => {
    const patch = buildWebhookPatch({
      initialWebhookUrl: "https://hooks.example",
      urlDraft: "https://hooks.example",
      secretDraft: null,
    });
    expect("notificationWebhookSecret" in patch).toBe(false);
  });

  it("can change URL and secret in the same patch", () => {
    expect(
      buildWebhookPatch({
        initialWebhookUrl: null,
        urlDraft: "https://hooks.example",
        secretDraft: "shh",
      }),
    ).toEqual({
      notificationWebhookUrl: "https://hooks.example",
      notificationWebhookSecret: "shh",
    });
  });
});
