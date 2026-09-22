import UIKit
import XCTest

extension XCTestCase {
    @MainActor
    func pairGatewayForUITest(
        in app: XCUIApplication,
        setupCode: String?,
        initialTab: String,
        initialDestination: String)
    {
        if let setupCode {
            UIPasteboard.general.string = setupCode
        }
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab",
            initialTab,
            "--openclaw-initial-destination",
            initialDestination,
        ]
        app.launch()

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()
        let setupCodeField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupCodeField.waitForExistence(timeout: 5))
        setupCodeField.tap()
        setupCodeField.press(forDuration: 1)
        XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 3))
        app.menuItems["Paste"].tap()
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 45))
        app.buttons["Go to Chat"].tap()
    }
}
