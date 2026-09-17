import type React from "react";
import { Box, Text } from "ink";
import { clipLine } from "@seekforge/shared/format";
import { agentRowDetail, agentRowLine, type AgentDraft } from "../manage/agents.js";
import { hookRowLine, hooksEmptyNote } from "../manage/hooks.js";
import type { ManageView } from "../manage/index.js";
import { mcpServerDetail, mcpServerLine } from "../manage/mcp.js";
import { permissionRowLine, type RuleDraft } from "../manage/permissions.js";
import { toggleRowLine } from "../manage/toggles.js";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";
import { listWindow } from "./Palette.js";

type Field = { label: string; value: string; choice?: boolean };

function FormFields({ fields, active }: { fields: Field[]; active: number }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {fields.map((field, i) => (
        <Text key={field.label} color={i === active ? ACCENT : undefined}>
          {i === active ? "❯ " : "  "}
          {field.label.padEnd(13)}
          {field.choice ? `‹ ${field.value} ›` : field.value}
          {i === active && !field.choice ? <Text inverse> </Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function ruleFields(draft: RuleDraft): Field[] {
  return [
    { label: t("manage.perm.fieldTool"), value: draft.tool },
    { label: t("manage.perm.fieldAction"), value: draft.action, choice: true },
    { label: t("manage.perm.fieldMatch"), value: draft.match },
    { label: t("manage.perm.fieldScope"), value: draft.scope, choice: true },
  ];
}

function agentFields(draft: AgentDraft): Field[] {
  return [
    { label: t("manage.agents.fieldId"), value: draft.id },
    { label: t("manage.agents.fieldDescription"), value: draft.description },
    { label: t("manage.agents.fieldTools"), value: draft.tools },
    { label: t("manage.agents.fieldMode"), value: draft.mode, choice: true },
    { label: t("manage.agents.fieldModel"), value: draft.model },
    { label: t("manage.agents.fieldScope"), value: draft.scope, choice: true },
  ];
}

function viewContent(view: ManageView): { title: string; lines: string[]; detail: string[]; footer: string } {
  switch (view.kind) {
    case "permissions": {
      const row = view.rows[view.index];
      return {
        title: t("manage.perm.title"),
        lines: view.rows.map(permissionRowLine),
        detail: row?.kind === "rule" ? [row.path] : [],
        footer: view.draft ? t("manage.formFooter") : t("manage.perm.footer"),
      };
    }
    case "mcp": {
      const server = view.servers[view.index];
      return {
        title: t("manage.mcp.title"),
        lines: view.servers.map(mcpServerLine),
        detail: server ? mcpServerDetail(server) : [t("manage.mcp.none")],
        footer: t("manage.mcp.footer"),
      };
    }
    case "agents": {
      const row = view.rows[view.index];
      return {
        title: t("manage.agents.title"),
        lines: view.rows.map(agentRowLine),
        detail: row ? [agentRowDetail(row)] : [],
        footer: view.draft ? t("manage.formFooter") : t("manage.agents.footer"),
      };
    }
    case "hooks": {
      const note = hooksEmptyNote(view.rows);
      return {
        title: t("manage.hooks.title"),
        lines: view.rows.map(hookRowLine),
        detail: note ? [note] : [],
        footer: t("manage.hooks.footer"),
      };
    }
    case "skills":
    case "plugins":
      return {
        title: view.kind === "skills" ? t("manage.skills.title") : t("manage.plugins.title"),
        lines: view.rows.map((row) => toggleRowLine(view.kind, row)),
        detail: [],
        footer: view.kind === "skills" ? t("manage.skills.footer") : t("manage.plugins.footer"),
      };
  }
}

/** The interactive /permissions, /mcp, /agents, /hooks, /skills and /plugins overlays. */
export function ManageOverlay({ view }: { view: ManageView }): React.ReactElement {
  const { title, lines, detail, footer } = viewContent(view);
  const { start, end } = listWindow(lines.length, view.index, 10);
  const draft =
    view.kind === "permissions" && view.draft ? (
      <FormFields fields={ruleFields(view.draft)} active={view.draft.field} />
    ) : view.kind === "agents" && view.draft ? (
      <FormFields fields={agentFields(view.draft)} active={view.draft.field} />
    ) : null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text color={ACCENT} bold>
        {title}
      </Text>
      {lines.length === 0 ? <Text dimColor>{t("picker.emptyList")}</Text> : null}
      {lines.slice(start, end).map((line, i) => {
        const absolute = start + i;
        const selected = absolute === view.index && !draft;
        return (
          <Text key={absolute} color={selected ? ACCENT : undefined} dimColor={!selected} wrap="truncate-end">
            {selected ? "❯ " : "  "}
            {line}
          </Text>
        );
      })}
      {draft}
      {!draft
        ? detail.map((line, i) => (
            <Text key={`d${i}`} dimColor wrap="truncate-end">
              {clipLine(line, 200)}
            </Text>
          ))
        : null}
      {view.message ? (
        <Text color={view.message.tone === "error" ? "red" : view.message.tone === "ok" ? "green" : undefined}>
          {view.message.text}
        </Text>
      ) : null}
      <Text dimColor>{footer}</Text>
    </Box>
  );
}
