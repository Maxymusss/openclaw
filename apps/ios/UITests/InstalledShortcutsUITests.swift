import UIKit
import XCTest

@MainActor
final class InstalledShortcutsUITests: XCTestCase {
    private struct Fixture: Decodable {
        let setupCode: String
        let profileID: String
        let gatewayID: String
        let controlURL: URL
        let scenarios: [Scenario]
    }

    private struct Scenario: Decodable {
        let id: String
        let sessionKey: String
        let sessionName: String
        let otherSessionName: String
        let shortcutName: String
        let question: String
        let runID: String?
        let checkpointURL: String
        let successURL: String
        var automatic: Bool {
            !self.id.hasSuffix("-off")
        }

        var sends: Bool {
            self.id.hasPrefix("send")
        }

        var retires: Bool {
            self.id == "send-away" || self.id == "send-aba"
        }
    }

    private var app: XCUIApplication?
    private var shortcuts: XCUIApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        self.continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        self.app?.terminate()
        self.shortcuts?.terminate()
        try super.tearDownWithError()
    }

    func testInstalledAutomaticRunOpeningPreservesOrigin() async throws {
        guard let value = ProcessInfo.processInfo.environment["OPENCLAW_IOS_SHORTCUTS_FIXTURE"] else {
            throw XCTSkip("Requires the isolated hosted Shortcuts fixture")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(value.utf8))
        XCTAssertEqual(fixture.scenarios.map(\.id), [
            "send-on", "send-off", "inspect-on", "inspect-off", "send-away", "send-aba",
        ])
        let app = XCUIApplication()
        self.app = app
        self.pairGatewayForUITest(in: app, setupCode: fixture.setupCode, initialTab: "chat", initialDestination: "chat")
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        self.shortcuts = shortcuts
        self.phase("onboarded")
        var finalRunID: String?
        for scenario in fixture.scenarios {
            self.dismissRun(in: app)
            let before = try self.assertIdleEditor(in: app)
            _ = try await self.control(fixture, scenario.id, "begin", ["observation": before])
            try self.create(scenario, in: shortcuts)
            try self.openEditor(scenario.shortcutName, in: shortcuts)
            self.expand(in: shortcuts)
            self.verifyToggle(scenario.automatic, in: shortcuts)
            self.assertHiddenParameters(in: shortcuts)
            self.choose("Done", in: shortcuts)
            var runURL = try XCTUnwrap(URLComponents(string: "shortcuts://x-callback-url/run-shortcut"))
            runURL.queryItems = [
                URLQueryItem(name: "name", value: scenario.shortcutName),
                URLQueryItem(name: "x-success", value: scenario.successURL),
            ]
            try shortcuts.open(XCTUnwrap(runURL.url))
            if scenario.sends {
                try self.confirm(scenario, fixture: fixture, in: app)
            }
            if scenario.retires {
                _ = try await self.control(fixture, scenario.id, "wait-held")
                app.activate()
                self.selectSession(scenario.otherSessionName, in: app)
                if scenario.id == "send-aba" { self.selectSession(scenario.sessionName, in: app) }
                let idle = try self.assertIdleEditor(in: app)
                _ = try await self.control(fixture, scenario.id, "release-ack", [
                    "emptyEditor": true, "selectedOwnerVerified": true, "observation": idle,
                ])
            }
            // The HTTP checkpoint may arrive before or after the returned intent.
            // Require actual owner completion independently, never infer its order.
            // OFF has no automatic completion to await. Its checkpoint proves the
            // producer returned after confirmation/ACK, not that a hidden task joined.
            if !scenario.automatic { try await self.waitForControl(fixture, scenario, key: "checkpoint") }
            var afterAutomatic = try self.waitForObservation(in: app) { value in
                (value["prepared"] as? Int) == (before["prepared"] as? Int).map { $0 + 1 } &&
                    (value["automaticCompletions"] as? Int) ==
                    (before["automaticCompletions"] as? Int).map { $0 + (scenario.automatic ? 1 : 0) }
            }
            if scenario.retires {
                XCTAssertEqual(afterAutomatic["automaticOutcome"] as? String, "skipped")
                self.assertSelectedSession(
                    scenario.id == "send-aba" ? scenario.sessionName : scenario.otherSessionName,
                    in: app)
                afterAutomatic = try self.assertIdleEditor(in: app)
                XCTAssertFalse(self.runSheet(in: app).exists)
            } else if scenario.automatic {
                XCTAssertTrue(self.runSheet(in: app).waitForExistence(timeout: 15))
            } else if !scenario.sends {
                // Inspect itself presents its result. OFF disables only its returned
                // automatic action; verify this producer-owned sheet separately.
                try self.verifyRun(
                    XCTUnwrap(scenario.runID),
                    session: scenario.sessionKey,
                    profile: fixture.profileID,
                    in: app)
                self.dismissRun(in: app)
            } else {
                XCTAssertFalse(self.runSheet(in: app).exists)
            }
            let observed = try await self.control(fixture, scenario.id, "observe", [
                "observation": afterAutomatic, "uiVerified": true,
            ])
            let runID = try XCTUnwrap(observed["runID"] as? String)
            if scenario.automatic, !scenario.retires {
                self.verifyRun(runID, session: scenario.sessionKey, profile: fixture.profileID, in: app)
                self.dismissRun(in: app)
            }
            try await self.waitForControl(fixture, scenario, key: "checkpoint")
            _ = try await self.control(fixture, scenario.id, "release-downstream")
            _ = try self.waitForObservation(in: app) { value in
                (value["explicitCompletions"] as? Int) == (before["explicitCompletions"] as? Int).map { $0 + 1 }
            }
            self.verifyRun(runID, session: scenario.sessionKey, profile: fixture.profileID, in: app)
            try await self.waitForControl(fixture, scenario, key: "finished")
            self.dismissRun(in: app)
            self.assertSelectedSession(scenario.sessionName, in: app)
            let settled = try self.assertIdleEditor(in: app)
            _ = try await self.control(fixture, scenario.id, "complete", [
                "observation": settled, "uiVerified": true,
            ])
            finalRunID = runID
            self.phase(scenario.id)
        }
        try await self.verifyExplicitDefaults(
            fixture,
            runID: XCTUnwrap(finalRunID),
            scenario: XCTUnwrap(fixture.scenarios.last),
            in: shortcuts,
            app: app)
        self.phase("complete")
    }

    private func create(_ scenario: Scenario, in shortcuts: XCUIApplication) throws {
        try shortcuts.open(XCTUnwrap(URL(string: "shortcuts://create-shortcut")))
        self.addAction(scenario.sends ? "Send Message" : "Inspect Run", in: shortcuts)
        if scenario.sends {
            let field = shortcuts.textFields["Message"].firstMatch
            XCTAssertTrue(field.waitForExistence(timeout: 10))
            field.tap()
            field.typeText(scenario.question)
            XCTAssertEqual(field.value as? String, scenario.question)
            self.choose("Session", in: shortcuts)
            self.choose(scenario.sessionName, in: shortcuts)
        } else {
            self.choose("Run", in: shortcuts)
            try self.choose(XCTUnwrap(scenario.runID), in: shortcuts)
        }
        self.expand(in: shortcuts)
        let toggle = shortcuts.switches["Open When Run"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "Returned-intent toggle is unavailable")
        if (toggle.value as? String == "1") != scenario.automatic { toggle.tap() }
        self.verifyToggle(scenario.automatic, in: shortcuts)
        self.addAction("Get Contents of URL", in: shortcuts)
        let url = shortcuts.textFields["URL"].firstMatch
        XCTAssertTrue(url.waitForExistence(timeout: 10))
        url.tap()
        url.typeText(scenario.checkpointURL + "\n")
        self.addAction("Open Run", in: shortcuts)
        self.expand(in: shortcuts)
        self.assertHiddenParameters(in: shortcuts)
        // Explicitly select the earlier Send output, never the immediately prior
        // HTTP response. Inspect returns text, so its explicit control uses its catalog Run.
        let run = shortcuts.buttons["Run"].allElementsBoundByIndex.last
        try XCTUnwrap(run).tap()
        if scenario.sends {
            self.choose("Select Variable", in: shortcuts)
            self.choose("Send Message", in: shortcuts)
        } else {
            try self.choose(XCTUnwrap(scenario.runID), in: shortcuts)
        }
        self.save(scenario.shortcutName, in: shortcuts)
    }

    private func verifyExplicitDefaults(
        _ fixture: Fixture, runID: String, scenario: Scenario,
        in shortcuts: XCUIApplication, app: XCUIApplication) async throws
    {
        let name = scenario.shortcutName + " Explicit"
        for id in ["explicit-fresh", "explicit-saved"] {
            self.dismissRun(in: app)
            let before = try self.assertIdleEditor(in: app)
            let control = try await self.control(fixture, id, "begin-explicit", ["observation": before])
            if id == "explicit-fresh" {
                try shortcuts.open(XCTUnwrap(URL(string: "shortcuts://create-shortcut")))
                self.addAction("Open Run", in: shortcuts)
                self.choose("Run", in: shortcuts)
                self.choose(runID, in: shortcuts)
            } else {
                try self.openEditor(name, in: shortcuts)
            }
            self.expand(in: shortcuts)
            self.assertHiddenParameters(in: shortcuts)
            if id == "explicit-fresh" {
                let run = shortcuts.buttons["Run Shortcut"].firstMatch
                XCTAssertTrue(run.waitForExistence(timeout: 10) && run.isEnabled)
                run.tap()
            } else {
                self.choose("Done", in: shortcuts)
                var url = try XCTUnwrap(URLComponents(string: "shortcuts://x-callback-url/run-shortcut"))
                url.queryItems = try [
                    URLQueryItem(name: "name", value: name),
                    URLQueryItem(
                        name: "x-success",
                        value: XCTUnwrap(control["successURL"] as? String)),
                ]
                try shortcuts.open(XCTUnwrap(url.url))
            }
            let after = try self.waitForObservation(in: app) { value in
                (value["explicitCompletions"] as? Int) == (before["explicitCompletions"] as? Int).map { $0 + 1 }
            }
            XCTAssertEqual(after["explicitOutcome"] as? String, "opened")
            for key in ["producers", "prepared", "automaticEntries", "automaticCompletions"] {
                XCTAssertEqual(after[key] as? Int, before[key] as? Int)
            }
            self.verifyRun(runID, session: scenario.sessionKey, profile: fixture.profileID, in: app)
            if id == "explicit-fresh" {
                shortcuts.activate()
                self.assertEditorRunCompleted(in: shortcuts)
                self.save(name, in: shortcuts)
            } else {
                let deadline = ContinuousClock.now + .seconds(40)
                var finished = false
                while ContinuousClock.now < deadline {
                    let status = try await self.control(fixture, id, "explicit-status")
                    if status["finished"] as? Bool == true { finished = true
                        break
                    }
                    try await Task.sleep(for: .milliseconds(50))
                }
                XCTAssertTrue(finished, "Saved explicit Shortcut did not complete")
            }
            _ = try await self.control(fixture, id, "complete-explicit", [
                "observation": after, "uiVerified": true, "shortcutSucceeded": true,
            ])
            self.phase(id)
        }
    }

    private func assertEditorRunCompleted(in shortcuts: XCUIApplication) {
        let run = shortcuts.buttons["Run Shortcut"].firstMatch
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            run.exists && run.isEnabled && !shortcuts.buttons["Stop Shortcut"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 30), .completed)
    }

    private func observation(in app: XCUIApplication) throws -> [String: Any] {
        app.activate()
        let marker = app.descendants(matching: .any)["RootTabs.InstalledNativeProof"].firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 10), "Proof build observer is absent")
        let value = try XCTUnwrap(marker.value as? String)
        XCTAssertLessThan(value.utf8.count, 1024)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }

    private func waitForObservation(
        in app: XCUIApplication, matching: @escaping ([String: Any]) -> Bool) throws -> [String: Any]
    {
        var last: [String: Any]?
        let expected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let value = try? self.observation(in: app), matching(value) else { return false }
            last = value
            return true
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expected], timeout: 45), .completed, "Actual native owner did not complete")
        return try XCTUnwrap(last)
    }

    private func control(
        _ fixture: Fixture, _ id: String, _ action: String, _ facts: [String: Any] = [:]) async throws -> [String: Any]
    {
        XCTAssertEqual(fixture.controlURL.host, "127.0.0.1")
        var request = URLRequest(url: fixture.controlURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        var payload = facts
        payload["action"] = action
        payload["id"] = id
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Installed fixture refused evidence")
        XCTAssertLessThan(data.count, 4096)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func waitForControl(_ fixture: Fixture, _ scenario: Scenario, key: String) async throws {
        let deadline = ContinuousClock.now + .seconds(40)
        while ContinuousClock.now < deadline {
            let status = try await self.control(fixture, scenario.id, "status")
            if status[key] as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("Actual Shortcuts checkpoint or success callback was not observed")
        throw CancellationError()
    }

    private func confirm(_ scenario: Scenario, fixture: Fixture, in app: XCUIApplication) throws {
        let text = "Send to \(scenario.sessionKey) with qa as \(fixture.profileID) on \(fixture.gatewayID)?\n\n\(scenario.question)"
        let containers = app.descendants(matching: .any).matching(NSPredicate(
            format: "elementType IN %@", [
                XCUIElement.ElementType.alert.rawValue,
                XCUIElement.ElementType.sheet.rawValue,
            ] as NSArray))
            .containing(.staticText, identifier: text)
        let confirmation = containers.firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 30))
        XCTAssertEqual(containers.count, 1)
        XCTAssertTrue(confirmation.isHittable)
        let send = confirmation.buttons["Send"].firstMatch
        XCTAssertTrue(send.isEnabled && send.isHittable)
        send.tap()
    }

    private func selectSession(_ name: String, in app: XCUIApplication) {
        self.dismissRun(in: app)
        let sidebar = app.buttons["RootTabs.Sidebar.Show"].firstMatch
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        sidebar.tap()
        let row = app.buttons.containing(.staticText, identifier: name).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        self.assertSelectedSession(name, in: app)
    }

    private func assertSelectedSession(_ name: String, in app: XCUIApplication) {
        let identity = app.descendants(matching: .any)["chat-agent-identity"].firstMatch
            .descendants(matching: .any)["chat-gateway-status"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 15))
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            identity.label.hasSuffix(". \(name)")
        }, object: nil)
        XCTAssertEqual(
            XCTWaiter.wait(for: [selected], timeout: 15),
            .completed,
            "Visible owner did not adopt the selected session")
    }

    @discardableResult
    private func assertIdleEditor(in app: XCUIApplication) throws -> [String: Any] {
        // Read the existing owner predicates; Send-button visibility alone can
        // hide submitting, advertised-run, branch-switch or attachment custody.
        let value = try self.waitForObservation(in: app) { $0["idleUnprotectedComposer"] as? Bool == true }
        let editor = app.textViews["chat-message-input"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertEqual(editor.value as? String, "")
        XCTAssertTrue(app.buttons["chat-send-message"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Stop response"].exists)
        XCTAssertFalse(self.runSheet(in: app).exists)
        return value
    }

    private func runSheet(in app: XCUIApplication) -> XCUIElement {
        app.sheets.containing(.navigationBar, identifier: "Run").firstMatch
    }

    private func dismissRun(in app: XCUIApplication) {
        let sheet = self.runSheet(in: app)
        if sheet.exists {
            sheet.buttons["Done"].firstMatch.tap()
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !sheet.exists }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 15), .completed)
        }
    }

    private func verifyRun(_ run: String, session: String, profile: String, in app: XCUIApplication) {
        app.activate()
        let sheet = self.runSheet(in: app)
        XCTAssertTrue(sheet.waitForExistence(timeout: 15))
        XCTAssertTrue(sheet.isHittable)
        for value in [run, session, profile, "qa"] {
            XCTAssertTrue(
                sheet.staticTexts[value].firstMatch.waitForExistence(timeout: 10),
                "Run association is not visible")
        }
    }

    private func expand(in shortcuts: XCUIApplication) {
        for _ in 0..<8 {
            let more = shortcuts.buttons["Show More"].firstMatch
            if !more.exists { return }
            more.tap()
        }
        XCTAssertFalse(shortcuts.buttons["Show More"].firstMatch.exists)
    }

    private func assertHiddenParameters(in shortcuts: XCUIApplication) {
        for title in ["Automatic", "Presentation"] {
            XCTAssertEqual(
                shortcuts.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).count,
                0,
                "Technical continuation parameters are exposed in Shortcuts")
        }
    }

    private func verifyToggle(_ enabled: Bool, in shortcuts: XCUIApplication) {
        let toggle = shortcuts.switches["Open When Run"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, enabled ? "1" : "0")
    }

    private func choose(_ label: String, in shortcuts: XCUIApplication) {
        let item = shortcuts.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 15), "Required Shortcuts control is missing")
        item.tap()
    }

    private func addAction(_ title: String, in shortcuts: XCUIApplication) {
        let search = shortcuts.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        if let value = search.value as? String, !value.isEmpty, value != search.placeholderValue {
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        search.typeText(title)
        let action = shortcuts.buttons[title].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 20), "Action is absent from Shortcuts")
        action.tap()
    }

    private func save(_ name: String, in shortcuts: XCUIApplication) {
        self.choose("New Shortcut", in: shortcuts)
        self.choose("Rename", in: shortcuts)
        let field = shortcuts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count))
        field.typeText(name + "\n")
        self.choose("Done", in: shortcuts)
    }

    private func openEditor(_ name: String, in shortcuts: XCUIApplication) throws {
        var url = try XCTUnwrap(URLComponents(string: "shortcuts://open-shortcut"))
        url.queryItems = [URLQueryItem(name: "name", value: name)]
        try shortcuts.open(XCTUnwrap(url.url))
    }

    private func phase(_ id: String) {
        print("[ios-shortcuts-installed] phase=\(id)")
    }
}
