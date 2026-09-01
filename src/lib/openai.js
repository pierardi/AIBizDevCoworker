import OpenAI from "openai";

function clientFor(apiKey) {
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
}

function stripFences(text) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function parseDraftPayload(text, topic) {
  const cleaned = stripFences(text);
  try {
    const data = JSON.parse(cleaned);
    return {
      subject: String(data.subject || topic).trim(),
      body: String(data.body || "").trim(),
    };
  } catch {
    return { subject: String(topic || "").slice(0, 90), body: text.trim() };
  }
}

function rankingPrompt({ userName, userHeadline, topic, batch }) {
  return `You are helping ${userName || "a professional"} \
(${userHeadline || "no headline provided"}) figure out which of \
their LinkedIn connections would most likely be interested in this topic:

TOPIC: "${topic}"

For each connection below (given as id, name, company, position), rate from 0-100 \
how likely they are to want to hear about this topic.

Score using BOTH of these, and weigh company fit heavily:
1. COMPANY MATCH: Infer what the company does from its name (industry, products, \
customers, business model). Does this topic matter to that company — would it \
help, sell to, compete with, or otherwise be relevant to that organization's work? \
A strong company match should score high even if the person's title is only loosely related. \
A poor company match should score low even if the title sounds relevant.
2. ROLE MATCH: Consider job function, seniority, and whether this person would \
plausibly own, influence, or care about the topic.

In "reason", mention the company-topic fit first, then the role if relevant.

Connections:
${JSON.stringify(batch, null, 2)}

Respond with ONLY a JSON array, no other text, in this exact format:
[{"id": 0, "score": 87, "reason": "one short phrase why"}, ...]
One entry per connection given, in any order.`;
}

export async function scoreBatch({ apiKey, userName, userHeadline, topic, batch }) {
  const openai = clientFor(apiKey);
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content: rankingPrompt({ userName, userHeadline, topic, batch }) }],
  });
  const text = stripFences(resp.choices[0].message.content || "");
  return JSON.parse(text);
}

export async function generateDraft({ apiKey, userName, userHeadline, person, topic }) {
  const firstName = (person.name || "").split(/\s+/)[0] || "there";
  const msgPrompt = `Write a short, warm, non-salesy outreach email from \
${userName || "me"} (${userHeadline || ""}) to ${person.name}, \
who works as ${person.position} at ${person.company}.

The message should introduce this topic and gauge interest, referencing why it's \
relevant to their company and role: "${topic}"

Keep the body under 80 words, greet with first name only (${firstName}), conversational tone, \
one clear soft call to action (e.g. "worth a quick chat?"). No hashtags, no emojis, \
no signature block.

Respond with ONLY JSON, no other text:
{"subject": "email subject line, under 70 characters", "body": "email body"}`;

  const openai = clientFor(apiKey);
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [{ role: "user", content: msgPrompt }],
  });
  return parseDraftPayload(resp.choices[0].message.content || "", topic);
}

export function emailToLine(person) {
  const name = person.name || "Unknown";
  const email = (person.email || "").trim();
  return email ? `${name} <${email}>` : `${name} (via LinkedIn)`;
}

export function exportCsv(ranked, drafts) {
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = [
    "Rank",
    "Name",
    "Position",
    "Company",
    "Email",
    "Score",
    "Reason",
    "Email Subject",
    "Draft Message",
  ];
  const lines = [header.join(",")];
  ranked.forEach((person, i) => {
    const draft = drafts[person.id] || {};
    lines.push(
      [
        i + 1,
        person.name,
        person.position,
        person.company,
        person.email,
        person.score,
        person.reason,
        draft.subject || "",
        draft.body || "",
      ]
        .map(escape)
        .join(","),
    );
  });
  return lines.join("\n");
}
