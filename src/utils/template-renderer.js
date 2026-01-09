export function renderTemplate(template, variables = {}) {
  if (!template) return "";

  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = variables[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
