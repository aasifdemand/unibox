export function renderTemplate(template, variables = {}) {
  if (!template) return "";

  // 0. Setup System Variables (Unibox style)
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const systemVars = {
    sl_time_of_day: timeOfDay,
    sl_day_of_week: days[now.getDay()],
    sl_current_month: now.toLocaleString('default', { month: 'long' }),
    sl_current_date: now.toLocaleDateString(),
  };

  const allVars = { ...systemVars, ...variables };

  // 0b. Inject %signature% — replace with sender's HTML signature or remove the token
  //     Must run BEFORE variable substitution so the signature itself can contain {{variables}}
  const signatureHtml = allVars.__signature__ || "";
  template = template.replace(/%signature%/gi, signatureHtml);

  // 1. Handle Spintax: {Option A|Option B|Option C} (Must contain |)
  const spintaxRegex = /{([^{}|]+?\|[^{}]+?)}/g;
  while (template.match(spintaxRegex)) {
    template = template.replace(spintaxRegex, (match, optionsStr) => {
      const choices = optionsStr.split('|');
      return choices[Math.floor(Math.random() * choices.length)];
    });
  }

  // 2. Handle Conditionals: {{#if key}} content {{else}} fallback {{/if}}
  const conditionalRegex = /{{\s*#if\s+([\w.]+)\s*}}([\s\S]*?)(?:{{\s*else\s*}}([\s\S]*?))?{{\s*\/if\s*}}/g;
  template = template.replace(conditionalRegex, (match, key, content, fallback) => {
    const value = allVars[key] ?? allVars[key.toLowerCase()];
    // If value is truthy and not an empty string
    if (value && String(value).trim() !== "") {
      return content;
    }
    return fallback || "";
  });

  // 3. Handle Variables: {{variable}}
  return template.replace(/{{\s*([\s\S]+?)\s*}}/g, (match, key) => {
    // Skip if it looks like a control tag that escaped step 2
    if (key.startsWith('#') || key.startsWith('/') || key.trim() === 'else') return match;

    const cleanedKey = key.replace(/<[^>]*>?/gm, "").trim();
    const value = allVars[cleanedKey] ?? allVars[cleanedKey.toLowerCase()];
    return value === undefined || value === null ? "" : String(value);
  });
}
