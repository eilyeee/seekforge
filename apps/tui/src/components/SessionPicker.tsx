import type React from "react";
import { Box, Text } from "ink";
import { clipLine } from "@seekforge/shared/format";
import { relativeAge } from "../format.js";
import {
  selectedSession,
  sessionLine,
  visibleSessions,
  type SessionPickerState,
  type SessionPreview,
} from "../session-picker.js";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";
import { listWindow } from "./Palette.js";

function previewLines(text: string, lines: number, width = 96): string[] {
  const out = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, lines)
    .map((line) => clipLine(line, width));
  return out;
}

/** /sessions: search field, windowed list, and a preview of the selected session. */
export function SessionPicker({
  state,
  preview,
}: {
  state: SessionPickerState;
  preview?: SessionPreview | null;
}): React.ReactElement {
  const rows = visibleSessions(state);
  const { start, end } = listWindow(rows.length, state.index, 8);
  const selected = selectedSession(state);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text color={ACCENT} bold>
        {t("picker.titleSessions")}{" "}
        <Text dimColor>
          ({rows.length}/{state.rows.length})
        </Text>
      </Text>
      {state.searching || state.query !== "" ? (
        <Text>
          <Text color={ACCENT}>/ </Text>
          <Text>{state.query}</Text>
          {state.searching ? <Text inverse> </Text> : null}
        </Text>
      ) : null}
      {rows.length === 0 ? <Text dimColor>{t("sessions.noMatch")}</Text> : null}
      {rows.slice(start, end).map((row, i) => {
        const absolute = start + i;
        const active = absolute === state.index;
        const renaming = state.renaming?.id === row.id;
        return (
          <Text key={row.id} color={active ? ACCENT : undefined} dimColor={!active}>
            {active ? "❯ " : "  "}
            {renaming ? (
              <>
                <Text color="yellow">{t("sessions.renamePrompt")} </Text>
                <Text>{state.renaming?.text}</Text>
                <Text inverse> </Text>
              </>
            ) : (
              sessionLine(row)
            )}
          </Text>
        );
      })}
      {selected && preview ? (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text dimColor>
            {selected.status} · {relativeAge(selected.updatedAt, Date.now())} ·{" "}
            {selected.costUsd === undefined ? "—" : `$${selected.costUsd.toFixed(4)}`} · {preview.messages}{" "}
            {t("sessions.messages")}
          </Text>
          {preview.firstPrompt ? (
            <>
              <Text color={ACCENT}>{t("sessions.firstPrompt")}</Text>
              {previewLines(preview.firstPrompt, 3).map((line, i) => (
                <Text key={`p${i}`}>{line}</Text>
              ))}
            </>
          ) : null}
          {preview.lastReply ? (
            <>
              <Text color={ACCENT}>{t("sessions.lastReply")}</Text>
              {previewLines(preview.lastReply, 5).map((line, i) => (
                <Text key={`r${i}`} dimColor>
                  {line}
                </Text>
              ))}
            </>
          ) : null}
        </Box>
      ) : null}
      <Text dimColor>
        {state.renaming
          ? t("sessions.renameFooter")
          : state.searching
            ? t("sessions.searchFooter")
            : t("picker.resume")}
      </Text>
    </Box>
  );
}
