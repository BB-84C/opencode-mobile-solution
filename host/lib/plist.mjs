// Renders launchd job definitions for the host services.
//
// This exists as a module rather than a heredoc so the rules below can be
// asserted by tests instead of being remembered:
//
//   - ProcessType is never emitted. Setting it to Background puts the job in a
//     throttled scheduling band; a Node service under that band has been
//     measured taking over 90 seconds to bind its port on this hardware.
//   - RunAtLoad + KeepAlive + ThrottleInterval are always present, which is the
//     combination running in production today.
//   - launchd does not read a login shell, so a job gets no PATH and no proxy
//     settings from the user's profile. Anything the service needs must be in
//     EnvironmentVariables or in the script it launches.

import path from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_KEYS = new Set(["ProcessType"]);

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderValue(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}  <string>${escapeXml(item)}</string>`).join("\n");
    return `${pad}<array>\n${items}\n${pad}</array>`;
  }
  if (typeof value === "boolean") return `${pad}<${value}/>`;
  if (typeof value === "number") return `${pad}<integer>${value}</integer>`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, inner]) => `${pad}  <key>${escapeXml(key)}</key>\n${renderValue(inner, indent + 2)}`)
      .join("\n");
    return `${pad}<dict>\n${entries}\n${pad}</dict>`;
  }
  return `${pad}<string>${escapeXml(value)}</string>`;
}

export function renderLaunchAgent({
  label,
  programArguments,
  standardOutPath,
  standardErrorPath,
  throttleInterval = 10,
  environment = null,
  workingDirectory = null,
}) {
  if (!label) throw new Error("label is required");
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    throw new Error("programArguments must be a non-empty array");
  }
  if (!standardOutPath || !standardErrorPath) throw new Error("both log paths are required");

  const job = {
    Label: label,
    ProgramArguments: programArguments,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: throttleInterval,
    StandardOutPath: standardOutPath,
    StandardErrorPath: standardErrorPath,
  };
  if (workingDirectory) job.WorkingDirectory = workingDirectory;
  if (environment && Object.keys(environment).length > 0) job.EnvironmentVariables = environment;

  for (const key of Object.keys(job)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${key} must never be set on these jobs`);
  }

  const body = Object.entries(job)
    .map(([key, value]) => `  <key>${escapeXml(key)}</key>\n${renderValue(value, 2)}`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

// Compare resolved paths, not URL strings: import.meta.url percent-encodes
// non-ASCII characters while argv[1] does not, so a repository checked out
// under a path containing CJK or spaces would silently skip this branch.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const spec = JSON.parse(process.argv[2] ?? "{}");
  process.stdout.write(renderLaunchAgent(spec));
}
