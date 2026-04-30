export function extractDurableUserFacts(text: string): string[] {
  const facts: string[] = [];
  const normalized = text.trim();
  if (!normalized) {
    return facts;
  }

  const patterns = [
    /(我喜欢[^。！？，,；;\n]{1,80})/g,
    /(我偏好[^。！？，,；;\n]{1,80})/g,
    /(请用[^。！？，,；;\n]{1,80})/g,
    /(以后[^。！？，,；;\n]{1,80})/g,
    /(记住[^。！？，,；;\n]{1,80})/g,
    /(我叫[^。！？，,；;\n]{1,40})/g,
    /(我的名字是[^。！？，,；;\n]{1,40})/g,
    /(请叫我[^。！？，,；;\n]{1,40})/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        facts.push(value);
      }
    }
  }

  return [...new Set(facts)];
}

export function extractDurableGroupFacts(text: string): string[] {
  const facts: string[] = [];
  const normalized = text.trim();
  if (!normalized) {
    return facts;
  }

  const patterns = [
    /(这个群[^。！？，,；;\n]{1,100})/g,
    /(我们项目[^。！？，,；;\n]{1,100})/g,
    /(项目代号[^。！？，,；;\n]{1,100})/g,
    /(默认使用[^。！？，,；;\n]{1,100})/g,
    /(统一走[^。！？，,；;\n]{1,100})/g,
    /(截止日期[^。！？，,；;\n]{1,100})/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        facts.push(value);
      }
    }
  }

  return [...new Set(facts)];
}
