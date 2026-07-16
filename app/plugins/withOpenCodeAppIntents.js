const fs = require('fs');
const path = require('path');

const { IOSConfig, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

const SWIFT_FILE_NAME = 'OpenCodeAppIntents.swift';

function generateOpenCodeAppIntentsSwift() {
  return `import AppIntents
import Foundation

private func openCodeIntentURL(_ rawValue: String) throws -> URL {
  guard let url = URL(string: rawValue) else {
    throw OpenCodeAppIntentError.invalidURL(rawValue)
  }
  return url
}

enum OpenCodeAppIntentError: Error, CustomLocalizedStringResourceConvertible {
  case invalidURL(String)

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .invalidURL:
      return "OpenCode could not build a handoff URL."
    }
  }
}

@available(iOS 18.0, *)
struct OpenSessionsIntent: AppIntent {
  static let title: LocalizedStringResource = "Open OpenCode Sessions"
  static let description = IntentDescription("Open the list of existing OpenCode sessions.")
  static let openAppWhenRun = true

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(try openCodeIntentURL("opencode://sessions")))
  }
}

@available(iOS 18.0, *)
struct OpenCodeMobileShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenSessionsIntent(),
      phrases: [
        "Open sessions in \\(.applicationName)",
        "Show OpenCode sessions in \\(.applicationName)"
      ],
      shortTitle: "Sessions",
      systemImageName: "text.bubble.fill"
    )
  }
}
`;
}

function writeSwiftFile({ projectRoot, projectName }) {
  const filePath = path.join(projectRoot, 'ios', projectName, SWIFT_FILE_NAME);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, generateOpenCodeAppIntentsSwift());
  return filePath;
}

function projectNameFromMod(modConfig) {
  const projectName = modConfig.modRequest.projectName;
  if (!projectName) throw new Error('OpenCode App Intents requires an iOS project name from Expo');
  return projectName;
}

function addSwiftFileToXcodeProject(project, projectName) {
  const target = project.getFirstTarget()?.uuid;
  if (!target) return project;

  const filePath = `${projectName}/${SWIFT_FILE_NAME}`;
  if (project.hasFile(filePath)) return project;

  const group = project.findPBXGroupKey({ name: projectName }) ?? project.findPBXGroupKey({ path: projectName });
  project.addSourceFile(filePath, { target, lastKnownFileType: 'sourcecode.swift' }, group);
  return project;
}

function withOpenCodeAppIntents(config) {
  config = withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      const projectName = projectNameFromMod(modConfig);
      writeSwiftFile({
        projectRoot: modConfig.modRequest.projectRoot,
        projectName,
      });
      return modConfig;
    },
  ]);

  return withXcodeProject(config, (modConfig) => {
    const projectName = projectNameFromMod(modConfig);
    modConfig.modResults = addSwiftFileToXcodeProject(modConfig.modResults, projectName);
    return modConfig;
  });
}

module.exports = withOpenCodeAppIntents;
module.exports.generateOpenCodeAppIntentsSwift = generateOpenCodeAppIntentsSwift;
module.exports.addSwiftFileToXcodeProject = addSwiftFileToXcodeProject;
module.exports.projectNameFromMod = projectNameFromMod;
module.exports.writeSwiftFile = writeSwiftFile;
