import type React from "react";
import { Box, Text } from "ink";
import type { PermissionRequest } from "@seekforge/shared";
import { clipLine } from "@seekforge/shared/format";
import { describeRule } from "../permission-store.js";
import {
  bodyRowCount,
  markdownWindow,
  offersAlways,
  offersSessionGrant,
  PERMISSION_BODY_HEIGHT,
  permissionBody,
} from "../permission-view.js";
import { t } from "../strings.js";
import { DiffCard } from "./DiffCard.js";
import { Markdown } from "./Markdown.js";

type PermissionPanelProps = {
  request: PermissionRequest;
  hunkSelection?: number[];
  /** First body row shown (↑↓/PgUp/PgDn scroll long diffs and plans). */
  scroll?: number;
  /** The deny reason being typed; undefined when not typing one. */
  reason?: string;
};

/** The one-line deny-with-reason input, shown under any panel variant. */
function ReasonInput({ reason }: { reason: string | undefined }): React.ReactElement | null {
  if (reason === undefined) return null;
  return (
    <Box marginTop={1}>
      <Text color="red">{t("permission.reasonPrompt")} </Text>
      <Text>{reason}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

/**
 * Inline permission prompt. ALWAYS surfaces the raw command/path verbatim —
 * never only the model's paraphrase (prompt-injection defense, AGENTS.md).
 * The parent wires keypress handling; this is presentation only.
 *
 * Edit-review: when `request.preview` is a unified diff (write tools), the
 * proposed diff is rendered above the y/n line and the prompt becomes an
 * explicit accept/reject review. A non-diff preview, or a long free-text
 * request such as a plan to approve, renders as scrollable markdown.
 *
 * Multi-hunk: when `hunks` has length > 1 and `hunkSelection` is provided,
 * render each hunk with a togglable checkbox and let the user choose specific
 * edits. Single-hunk and no-hunk requests behave exactly as before.
 */
export function PermissionPanel({
  request,
  hunkSelection,
  scroll = 0,
  reason,
}: PermissionPanelProps): React.ReactElement {
  const preview = request.preview;
  const hunks = request.hunks;
  const isMultiHunk = hunks && hunks.length > 1;
  const body = permissionBody(request);
  const sessionGrant = offersSessionGrant(request);

  // Multi-hunk edit-review: render per-hunk previews with selection checkboxes.
  if (isMultiHunk && preview) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text color="yellow" bold>
          {t("permission.reviewChange")} <Text bold>{preview.path}</Text>{" "}
          <Text dimColor>
            [{request.permission}] {request.toolName}
          </Text>
        </Text>
        {hunks.map((hunk) => {
          const selected = hunkSelection?.includes(hunk.index) ?? true;
          return (
            <Box key={hunk.index} flexDirection="column">
              <Text>
                <Text color={selected ? "green" : "red"}>{selected ? "[x]" : "[ ]"}</Text>
                <Text> </Text>
                <Text bold>
                  {t("permission.hunk")} {hunk.index + 1}
                </Text>
              </Text>
              <Box paddingLeft={4}>
                <Text dimColor>{clipLine(hunk.preview, 200)}</Text>
              </Box>
            </Box>
          );
        })}
        <Text dimColor>
          {t("permission.hunkFooter")} · {t("permission.denyReason")}
        </Text>
        <ReasonInput reason={reason} />
      </Box>
    );
  }

  if (body.kind === "diff") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text color="yellow" bold>
          {t("permission.reviewChange")} <Text bold>{body.path}</Text>{" "}
          <Text dimColor>
            [{request.permission}] {request.toolName}
          </Text>
        </Text>
        <DiffCard path={body.path} lines={body.lines} maxLines={PERMISSION_BODY_HEIGHT} offset={scroll} />
        <Text dimColor>
          {t("permission.applyChange")} · {t("permission.denyReason")}
        </Text>
        <ReasonInput reason={reason} />
      </Box>
    );
  }

  const rows = bodyRowCount(body);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text color="yellow" bold>
        {body.kind === "markdown" ? t("permission.reviewPlan") : t("permission.title")}{" "}
        <Text dimColor>
          [{request.permission}] {request.toolName}
        </Text>
      </Text>
      {request.command ? (
        <Text>
          <Text dimColor>{t("permission.command")} </Text>
          <Text bold>{request.command}</Text>
        </Text>
      ) : null}
      {request.path ? (
        <Text>
          <Text dimColor>{t("permission.path")} </Text>
          <Text bold>{request.path}</Text>
        </Text>
      ) : null}
      {body.kind === "markdown" ? (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {scroll > 0 ? (
            <Text dimColor>
              ↑ {scroll} {t("permission.moreLines")}
            </Text>
          ) : null}
          <Markdown text={markdownWindow(body.text, scroll)} />
          {rows - scroll > PERMISSION_BODY_HEIGHT ? (
            <Text dimColor>
              ↓ {rows - scroll - PERMISSION_BODY_HEIGHT} {t("permission.moreLines")}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {body.kind === "plain" && !request.command && !request.path ? <Text>{request.description}</Text> : null}
      {/* The rule "A" would write, verbatim — the same object core hands to the
          host's persistRule sink, so nothing here is a description of it. */}
      {offersAlways(request) && request.rememberRule ? (
        <Text>
          <Text dimColor>{t("permission.allowAlways")} </Text>
          <Text bold>{describeRule(request.rememberRule)}</Text>
        </Text>
      ) : null}
      <Text dimColor>
        {t("permission.allowOnce")}
        {sessionGrant ? ` · ${request.command ? t("permission.allowSession") : t("permission.allowToolSession")}` : ""}{" "}
        · {t("permission.denyReason")} · {t("permission.deny")}
      </Text>
      <ReasonInput reason={reason} />
    </Box>
  );
}
