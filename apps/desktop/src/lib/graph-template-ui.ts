export type DesktopGraphTemplate = {
  key: string;
  label: string;
  template: Record<string, unknown>;
  deprecated: boolean;
};

export type GraphTemplateParameterField = {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  defaultValue?: string | number | boolean;
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

export function graphTemplateParameterFields(value: unknown): GraphTemplateParameterField[] {
  if (!record(value) || value.kind !== "engineering-graph-template" || !record(value.parameters)) return [];
  return Object.entries(value.parameters).flatMap(([name, parameter]): GraphTemplateParameterField[] => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) ||
      !record(parameter) ||
      (parameter.type !== "string" && parameter.type !== "number" && parameter.type !== "boolean")
    ) {
      return [];
    }
    const defaultValue = parameter.default;
    const validDefault =
      typeof defaultValue === parameter.type && (typeof defaultValue !== "number" || Number.isFinite(defaultValue));
    return [
      {
        name,
        type: parameter.type,
        ...(typeof parameter.description === "string" && parameter.description.length <= 1024
          ? { description: parameter.description }
          : {}),
        ...(validDefault ? { defaultValue: defaultValue as string | number | boolean } : {}),
      },
    ];
  });
}

export function setGraphTemplateParameter(
  parameters: Readonly<Record<string, unknown>>,
  field: GraphTemplateParameterField,
  value: string | number | boolean | undefined,
): Record<string, unknown> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(field.name) ||
    (field.type !== "string" && field.type !== "number" && field.type !== "boolean") ||
    (value !== undefined && (typeof value !== field.type || (typeof value === "number" && !Number.isFinite(value))))
  ) {
    throw new Error(`Graph template parameter ${field.name} has an invalid value`);
  }
  const next = Object.create(null) as Record<string, unknown>;
  for (const [name, current] of Object.entries(parameters)) next[name] = current;
  if (value === undefined) delete next[field.name];
  else next[field.name] = value;
  return next;
}
