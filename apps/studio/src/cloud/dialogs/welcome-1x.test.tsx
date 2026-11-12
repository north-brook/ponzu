import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { BlockingDialog, DialogButton } from "./blocking-dialog.tsx";
import { WELCOME_1X_BODY, WELCOME_1X_TITLE, Welcome1xSheet } from "./welcome-1x.tsx";

/** Every element under `node`, depth first, as React holds them (nothing is rendered). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child, ...elements(child.props.children as ReactNode));
  });
  return found;
}

test("the welcome from 1.x says the design's words, exactly, with one button", () => {
  expect(WELCOME_1X_TITLE).toBe("Ponzu works in the cloud now");
  expect(WELCOME_1X_BODY).toBe(
    "Your canvases, threads and the agent now live in Ponzu Cloud, the same on every Mac and on your iPhone. The .design folders Ponzu 1 made are still on this computer, where you left them; this version doesn't open them.",
  );

  let continued = 0;
  const sheet = Welcome1xSheet({ open: true, onContinue: () => continued++ });
  expect(sheet.type).toBe(BlockingDialog);
  const props = sheet.props as Parameters<typeof BlockingDialog>[0];
  expect(props.open).toBe(true);
  expect(props.title).toBe(WELCOME_1X_TITLE);
  expect(props.body).toBe(WELCOME_1X_BODY);

  const buttons = elements(props.children).filter((el) => el.type === DialogButton);
  expect(buttons.map((button) => button.props.children)).toEqual(["Continue"]);
  expect(buttons[0]!.props.tone).toBe("primary");
  (buttons[0]!.props.onClick as () => void)();
  // Escape or a click on the dim is the same as Continue: it was seen.
  props.onDismiss();
  expect(continued).toBe(2);
});

test("closed, the sheet is closed", () => {
  const sheet = Welcome1xSheet({ open: false, onContinue: () => {} });
  expect((sheet.props as { open: boolean }).open).toBe(false);
});
