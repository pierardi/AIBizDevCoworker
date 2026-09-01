function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseLinkedInCsv(text) {
  const lines = text.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));
  let headerIdx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes("First Name") && lines[i].includes("Last Name")) {
      headerIdx = i;
      break;
    }
  }
  const headers = parseCsvLine(lines[headerIdx] || "").map((h) => h.trim());
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || "").trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}

function col(headers, fragment) {
  return headers.find((h) => h.includes(fragment)) || null;
}

export function rowsToRoster(headers, rows) {
  const nameCols = headers.filter((h) => h.includes("Name"));
  const companyCol = col(headers, "Company");
  const positionCol = col(headers, "Position");
  const emailCol = col(headers, "Email");
  return rows.map((row, id) => ({
    id,
    name: nameCols.map((c) => row[c] || "").join(" ").trim(),
    company: companyCol ? row[companyCol] || "" : "",
    position: positionCol ? row[positionCol] || "" : "",
    email: emailCol && row[emailCol] ? row[emailCol] : "",
  }));
}
