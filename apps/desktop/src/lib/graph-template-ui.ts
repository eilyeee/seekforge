export type DesktopGraphTemplate = {
  key: string;
  label: string;
  template: Record<string, unknown>;
  deprecated: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decodes the registry transport wrapper without duplicating Core's semantic validator. */
export function decodeDesktopGraphTemplates(value: unknown): { templates: DesktopGraphTemplate[]; skipped: number } {
  if (!Array.isArray(value) || value.length > 64)
    return { templates: [], skipped: Array.isArray(value) ? value.length : 1 };
  const templates: DesktopGraphTemplate[] = [];
  const seenKeys = new Set<string>();
  let skipped = 0;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      skipped++;
      continue;
    }
    const entry = value[index];
    if (!record(entry) || !record(entry.template)) {
      skipped++;
      continue;
    }
    const template = entry.template;
    if (
      template.schemaVersion !== 2 ||
      template.kind !== "engineering-graph-template" ||
      typeof template.templateId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(template.templateId) ||
      typeof template.version !== "string" ||
      template.version.length < 1 ||
      template.version.length > 64 ||
      !record(template.parameters) ||
      !record(template.definition) ||
      typeof entry.registeredAt !== "string" ||
      !Number.isFinite(Date.parse(entry.registeredAt)) ||
      (entry.deprecatedAt !== undefined &&
        (typeof entry.deprecatedAt !== "string" || !Number.isFinite(Date.parse(entry.deprecatedAt))))
    ) {
      skipped++;
      continue;
    }
    const key = `${template.templateId}@${template.version}`;
    if (seenKeys.has(key)) {
      skipped++;
      continue;
    }
    seenKeys.add(key);
    templates.push({
      key,
      label: key,
      template,
      deprecated: entry.deprecatedAt !== undefined,
    });
  }
  return { templates, skipped };
}

export function graphTemplateVisualDefinition(value: unknown): unknown {
  return record(value) && value.kind === "engineering-graph-template" && record(value.definition)
    ? value.definition
    : value;
}

export function graphTemplateDefaultParameters(value: unknown): Record<string, string | number | boolean> {
  const defaults = Object.create(null) as Record<string, string | number | boolean>;
  if (!record(value) || !record(value.parameters)) return defaults;
  for (const [name, parameter] of Object.entries(value.parameters)) {
    if (!record(parameter) || !Object.hasOwn(parameter, "default")) continue;
    const defaultValue = parameter.default;
    if (
      typeof defaultValue === "string" ||
      typeof defaultValue === "boolean" ||
      (typeof defaultValue === "number" && Number.isFinite(defaultValue))
    ) {
      defaults[name] = defaultValue;
    }
  }
  return defaults;
}
