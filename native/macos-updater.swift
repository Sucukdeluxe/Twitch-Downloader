import AppKit
import Darwin
import Foundation

// This executable never elevates privileges. Authentication of the release manifest
// and archive happens in the app; identity and sealed bundle integrity are checked
// again here, on both sides of the shutdown handshake.
private struct InstallPlan: Decodable {
    let schema: Int
    let parentPid: Int32
    let targetApp: String
    let stagedApp: String
    let expectedBundleId: String
    let expectedVersion: String
    let healthToken: String
    let stateDirectory: String
    let userDataDirectory: String?
}

private struct UpdateFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private struct FileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t
}

#if UPDATER_TESTING
// Only the separately compiled integration-test binary has shorter deadlines.
private let armTimeout: TimeInterval = 4
private let parentTimeout: TimeInterval = 4
private let healthTimeout: TimeInterval = 5
#else
private let armTimeout: TimeInterval = 120
private let parentTimeout: TimeInterval = 90
private let healthTimeout: TimeInterval = 60
#endif

private let fm = FileManager.default

private func metadata(_ path: String) throws -> stat {
    var value = stat()
    guard lstat(path, &value) == 0 else { throw UpdateFailure("Cannot inspect \(path): \(String(cString: strerror(errno)))") }
    return value
}

private func identity(_ path: String) throws -> FileIdentity {
    let value = try metadata(path)
    return FileIdentity(device: value.st_dev, inode: value.st_ino)
}

private func canonicalPath(_ path: String) throws -> String {
    guard path.hasPrefix("/"), !path.contains("\0"),
          let resolved = realpath(path, nil) else { throw UpdateFailure("Path must be absolute and existing: \(path)") }
    defer { free(resolved) }
    guard String(cString: resolved) == path else { throw UpdateFailure("Symbolic links are not allowed in installation paths: \(path)") }
    return path
}

private func secureRegularFile(_ path: String) throws -> Data {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw UpdateFailure("Cannot safely open \(path)") }
    defer { close(descriptor) }
    var value = stat()
    guard fstat(descriptor, &value) == 0,
          value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          value.st_uid == getuid(), value.st_mode & 0o022 == 0,
          value.st_nlink == 1, value.st_size > 0, value.st_size <= 32_768 else {
        throw UpdateFailure("Unsafe state file: \(path)")
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    return try handle.readToEnd() ?? Data()
}

private func isPresent(_ path: String) -> Bool {
    var value = stat()
    return lstat(path, &value) == 0
}

private func pump(_ seconds: TimeInterval = 0.05) {
    if !RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: seconds)) {
        usleep(useconds_t(seconds * 1_000_000))
    }
}

private func parentIsAlive(_ pid: Int32) -> Bool {
    return kill(pid, 0) == 0 || errno == EPERM
}

private func verifySignature(_ app: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    process.arguments = ["--verify", "--deep", "--strict", app]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let deadline = ProcessInfo.processInfo.systemUptime + 45
    while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline { pump() }
    if process.isRunning {
        process.terminate()
        let terminationDeadline = ProcessInfo.processInfo.systemUptime + 2
        while process.isRunning && ProcessInfo.processInfo.systemUptime < terminationDeadline { pump() }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        throw UpdateFailure("Code signature verification timed out")
    }
    guard process.terminationStatus == 0 else { throw UpdateFailure("Code signature verification failed for \(app)") }
}

private func verifyBundle(_ path: String, bundleId: String, version: String?) throws {
    _ = try canonicalPath(path)
    let value = try metadata(path)
    guard path.hasSuffix(".app"), value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
        throw UpdateFailure("Installation requires real .app directories")
    }
    let plistPath = path + "/Contents/Info.plist"
    _ = try canonicalPath(plistPath)
    let data = try Data(contentsOf: URL(fileURLWithPath: plistPath))
    guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          info["CFBundleIdentifier"] as? String == bundleId,
          let executable = info["CFBundleExecutable"] as? String,
          !executable.isEmpty, !executable.contains("/"), !executable.contains("\0"),
          executable != ".", executable != ".." else { throw UpdateFailure("Application bundle identity is invalid") }
    if let version = version, info["CFBundleShortVersionString"] as? String != version {
        throw UpdateFailure("Staged application version does not match the authenticated release")
    }
    let executablePath = path + "/Contents/MacOS/" + executable
    _ = try canonicalPath(executablePath)
    let executableMetadata = try metadata(executablePath)
    guard executableMetadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), access(executablePath, X_OK) == 0 else {
        throw UpdateFailure("Bundle executable is missing or not executable")
    }
    try verifySignature(path)
}

private final class Installer {
    let plan: InstallPlan
    let targetIdentity: FileIdentity
    let stagedIdentity: FileIdentity
    let stateIdentity: FileIdentity
    var swapped = false
    var launchedApp: NSRunningApplication?

    init(plan: InstallPlan, planPath: String) throws {
        self.plan = plan
        guard plan.schema == 1, plan.parentPid > 1, plan.parentPid != getpid(),
              plan.healthToken.count == 64, plan.healthToken.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil,
              !plan.expectedBundleId.isEmpty, !plan.expectedVersion.isEmpty else { throw UpdateFailure("Invalid installation plan") }
        _ = try canonicalPath(plan.stateDirectory)
        let state = try metadata(plan.stateDirectory)
        guard state.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), state.st_uid == getuid(), state.st_mode & 0o022 == 0,
              URL(fileURLWithPath: planPath).deletingLastPathComponent().path == plan.stateDirectory,
              access(plan.stateDirectory, W_OK | X_OK) == 0 else { throw UpdateFailure("Unsafe or unwritable update state directory") }
        self.stateIdentity = try identity(plan.stateDirectory)
        self.targetIdentity = try identity(plan.targetApp)
        self.stagedIdentity = try identity(plan.stagedApp)
        if let userData = plan.userDataDirectory {
            _ = try canonicalPath(userData)
            let value = try metadata(userData)
            guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), value.st_uid == getuid(),
                  !userData.hasPrefix(plan.targetApp + "/"), !userData.hasPrefix(plan.stagedApp + "/") else {
                throw UpdateFailure("Unsafe application profile directory")
            }
        }
    }

    func statePath(_ name: String) -> String { plan.stateDirectory + "/" + name + "-" + plan.healthToken + ".json" }

    func writeState(_ name: String, _ fields: [String: Any]) throws {
        guard try identity(plan.stateDirectory) == stateIdentity else { throw UpdateFailure("Update state directory changed") }
        var value = fields
        value["schema"] = 1
        value["token"] = plan.healthToken
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: statePath(name)), options: [.atomic])
        if name == "result" {
            // A convenience summary for the next regular application launch.
            try data.write(to: URL(fileURLWithPath: plan.stateDirectory + "/result.json"), options: [.atomic])
        }
    }

    func readMarker(_ name: String) throws -> [String: Any]? {
        guard try identity(plan.stateDirectory) == stateIdentity else { throw UpdateFailure("Update state directory changed") }
        let path = statePath(name)
        guard isPresent(path) else { return nil }
        let data = try secureRegularFile(path)
        guard let marker = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              marker["schema"] as? Int == 1, marker["token"] as? String == plan.healthToken else {
            throw UpdateFailure("Invalid \(name) acknowledgment")
        }
        return marker
    }

    func validateApps() throws {
        let targetParent = URL(fileURLWithPath: plan.targetApp).deletingLastPathComponent().path
        let stageParent = URL(fileURLWithPath: plan.stagedApp).deletingLastPathComponent().path
        guard plan.targetApp != plan.stagedApp, targetParent == stageParent,
              targetIdentity != stagedIdentity, targetIdentity.device == stagedIdentity.device,
              !plan.stateDirectory.hasPrefix(plan.targetApp + "/"),
              !plan.stateDirectory.hasPrefix(plan.stagedApp + "/"),
              access(targetParent, W_OK | X_OK) == 0 else { throw UpdateFailure("Applications must be distinct siblings on a writable filesystem") }
        guard try identity(plan.targetApp) == targetIdentity, try identity(plan.stagedApp) == stagedIdentity,
              try metadata(plan.stagedApp).st_uid == getuid() else { throw UpdateFailure("Application directories changed or have an unsafe owner") }
        try verifyBundle(plan.targetApp, bundleId: plan.expectedBundleId, version: nil)
        try verifyBundle(plan.stagedApp, bundleId: plan.expectedBundleId, version: plan.expectedVersion)
    }

    func handshake() throws {
        for name in ["ready", "proceed", "armed", "health", "result"] {
            guard !isPresent(statePath(name)) else { throw UpdateFailure("Update token was already used") }
        }
        try validateApps()
        guard parentIsAlive(plan.parentPid) else { throw UpdateFailure("Parent exited before update preparation") }
        try writeState("ready", ["status": "ready", "pid": getpid()])
        let armDeadline = ProcessInfo.processInfo.systemUptime + armTimeout
        while ProcessInfo.processInfo.systemUptime < armDeadline {
            guard parentIsAlive(plan.parentPid) else { throw UpdateFailure("Parent exited without arming the update") }
            if try readMarker("proceed") != nil {
                try writeState("armed", ["status": "armed", "pid": getpid()])
                let exitDeadline = ProcessInfo.processInfo.systemUptime + parentTimeout
                while parentIsAlive(plan.parentPid) && ProcessInfo.processInfo.systemUptime < exitDeadline { pump() }
                guard !parentIsAlive(plan.parentPid) else { throw UpdateFailure("Parent did not exit; original application was preserved") }
                guard try readMarker("proceed") != nil else { throw UpdateFailure("Update authorization was withdrawn") }
                return
            }
            pump()
        }
        throw UpdateFailure("Update was not armed before its deadline")
    }

    func swap() throws {
        guard renamex_np(plan.targetApp, plan.stagedApp, UInt32(RENAME_SWAP)) == 0 else {
            throw UpdateFailure("Atomic application exchange failed: \(String(cString: strerror(errno)))")
        }
        swapped.toggle()
    }

    func launch(_ arguments: [String]) throws -> NSRunningApplication {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = true
        configuration.promptsUserIfNeeded = false
        configuration.arguments = arguments + (plan.userDataDirectory.map { ["--user-data-dir=" + $0] } ?? [])
        configuration.environment = ProcessInfo.processInfo.environment
        let completion = DispatchSemaphore(value: 0)
        var result: NSRunningApplication?
        var failure: Error?
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: plan.targetApp), configuration: configuration) { app, error in
            result = app
            failure = error
            completion.signal()
        }
        // Launch Services requests cannot be cancelled. Do not start rollback on
        // an arbitrary callback timeout: a late launch would then race the
        // restored app. Once the callback supplies a PID, health is bounded.
        // The callback runs on a concurrent queue. The semaphore also publishes
        // result/failure safely to this thread before either value is inspected.
        while completion.wait(timeout: .now()) == .timedOut { pump() }
        guard let app = result else { throw UpdateFailure("Application launch failed: \(failure?.localizedDescription ?? "unknown Launch Services error")") }
        return app
    }

    func awaitHealth(_ app: NSRunningApplication) throws {
        let deadline = ProcessInfo.processInfo.systemUptime + healthTimeout
        repeat {
            if let marker = try readMarker("health") {
                guard marker["version"] as? String == plan.expectedVersion,
                      marker["pid"] as? Int32 == app.processIdentifier,
                      !app.isTerminated else { throw UpdateFailure("Replacement application health acknowledgment is invalid") }
                return
            }
            guard !app.isTerminated else { throw UpdateFailure("Replacement application exited before acknowledging health") }
            pump()
        } while ProcessInfo.processInfo.systemUptime < deadline
        // An acknowledgment arriving after the deadline cannot race the rollback.
        throw UpdateFailure("Replacement application did not acknowledge health before its deadline")
    }

    func stopReplacement() throws {
        guard let app = launchedApp, !app.isTerminated else { return }
        app.terminate()
        var deadline = ProcessInfo.processInfo.systemUptime + 5
        while !app.isTerminated && ProcessInfo.processInfo.systemUptime < deadline { pump() }
        if !app.isTerminated {
            app.forceTerminate()
            deadline = ProcessInfo.processInfo.systemUptime + 5
            while !app.isTerminated && ProcessInfo.processInfo.systemUptime < deadline { pump() }
        }
        guard app.isTerminated else { throw UpdateFailure("Cannot stop the failed replacement application; backup retained at \(plan.stagedApp)") }
    }

    func requireNoIndependentInstance(_ operation: String) throws {
        // A separate profile (or a manual launch during the health window) can
        // bypass the parent application's single-instance lock. Never exchange
        // the bundle underneath an application this transaction does not own.
        func resolved(_ url: URL?) -> String? {
            guard let path = url?.path, let result = realpath(path, nil) else { return nil }
            defer { free(result) }
            return String(cString: result)
        }
        let independent = NSWorkspace.shared.runningApplications.filter { app in
            guard !app.isTerminated, app.processIdentifier != plan.parentPid,
                  app.processIdentifier != launchedApp?.processIdentifier else { return false }
            if resolved(app.bundleURL) == plan.targetApp { return true }
            return resolved(app.executableURL)?.hasPrefix(plan.targetApp + "/Contents/MacOS/") == true
        }
        guard independent.isEmpty else {
            let pids = independent.map { String($0.processIdentifier) }.joined(separator: ", ")
            let recovery = swapped ? "original backup retained at \(plan.stagedApp)" : "original application was preserved"
            throw UpdateFailure("Cannot \(operation) while another application instance is running (PID \(pids)); \(recovery). Close the other instance before retrying.")
        }
    }

    func install() throws {
        try handshake()
        try requireNoIndependentInstance("install the update")
        // Recheck sealed contents after the parent stopped; no destructive action
        // occurs before both explicit authorization and observed process exit.
        try validateApps()
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        try writeState("result", ["status": "installing", "targetApp": plan.targetApp, "backupApp": plan.stagedApp])
        try requireNoIndependentInstance("install the update")
        try swap()
        do {
            let app = try launch(["--mac-update-token=" + plan.healthToken, "--mac-update-state=" + plan.stateDirectory])
            launchedApp = app
            try awaitHealth(app)
        } catch {
            let originalFailure = String(describing: error)
            try requireNoIndependentInstance("roll back the update")
            try stopReplacement()
            try requireNoIndependentInstance("roll back the update")
            guard try identity(plan.targetApp) == stagedIdentity, try identity(plan.stagedApp) == targetIdentity else {
                throw UpdateFailure("Application directories changed during rollback; original backup retained at \(plan.stagedApp)")
            }
            try swap()
            var message = originalFailure + "; original application restored"
            do { _ = try launch([]) } catch { message += "; original application could not relaunch: \(error)" }
            try writeState("result", ["status": "rolled-back", "message": message, "targetApp": plan.targetApp])
            return
        }
        var message = "Application updated and health verified"
        var fields: [String: Any] = ["status": "installed", "version": plan.expectedVersion, "targetApp": plan.targetApp]
        do {
            guard try identity(plan.stagedApp) == targetIdentity else { throw UpdateFailure("Backup directory changed") }
            try fm.removeItem(atPath: plan.stagedApp)
        } catch {
            message += "; old application backup retained: \(error)"
            fields["backupApp"] = plan.stagedApp
        }
        fields["message"] = message
        try writeState("result", fields)
    }
}

private var installer: Installer?
do {
    signal(SIGHUP, SIG_IGN)
    guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--install" else {
        throw UpdateFailure("Usage: macos-updater --install /absolute/path/to/plan.json")
    }
    let planPath = try canonicalPath(CommandLine.arguments[2])
    let plan = try JSONDecoder().decode(InstallPlan.self, from: secureRegularFile(planPath))
    let instance = try Installer(plan: plan, planPath: planPath)
    installer = instance
    try instance.install()
} catch {
    let message = String(describing: error)
    if let instance = installer {
        try? instance.writeState("result", ["status": "failed", "message": message,
                                            "targetApp": instance.plan.targetApp,
                                            "backupApp": instance.swapped ? instance.plan.stagedApp : ""])
    }
    FileHandle.standardError.write(Data(("macos-updater: " + message + "\n").utf8))
    exit(1)
}
