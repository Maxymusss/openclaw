import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
final class NativeActionVisualProofTests: XCTestCase {
    func testInspectionRetiresWhenSelectedAgentChanges() async throws {
        try await self.runNativeVisualProof(.inspection)
    }

    func testHiddenSidebarChoiceCancelsNativePreparation() async throws {
        try await self.runNativeVisualProof(.sidebarChoice)
    }

    func testHiddenSidebarChoiceABACancelsNativePreparation() async throws {
        try await self.runNativeVisualProof(.sidebarABA)
    }

    func testRootUserNavigationCancelsHeldNativeHistory() async throws {
        for scenario in [
            Scenario.overviewGear,
            .sameKeySession,
            .settingsPush,
            .settingsPop,
            .settingsABA,
            .dashboardPush,
            .dashboardPop,
            .watchDetail,
            .licenseDetail,
            .headersDetail,
            .logsDetail,
            .sheetDone,
            .sheetEscape,
            .externalDashboard,
        ] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testNativeOpenPreservesInternalSettingsAndChatProjection() async throws {
        for scenario in [Scenario.nativeFromSettingsPath, .nativeAfterUserChat, .sidebarFork] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testSidebarNewChatUsesRootOperationTask() async throws {
        try await self.runNativeVisualProof(.sidebarNewChat)
    }

    private enum Scenario {
        case inspection
        case sidebarChoice
        case sidebarABA
        case overviewGear, sameKeySession, settingsPush, settingsPop, settingsABA
        case dashboardPush, dashboardPop, watchDetail, licenseDetail, headersDetail, logsDetail
        case sheetDone, sheetEscape, externalDashboard
        case nativeFromSettingsPath, nativeAfterUserChat, sidebarFork, sidebarNewChat

        var initialDestination: String {
            switch self {
            case .sidebarChoice, .overviewGear, .sameKeySession, .sheetDone, .sheetEscape, .nativeAfterUserChat,
                 .sidebarFork: "overview"
            case .dashboardPush, .dashboardPop: "usage"
            default: "settings"
            }
        }

        var initialPanel: String? {
            switch self {
            case .settingsPop, .dashboardPop, .nativeFromSettingsPath, .logsDetail: "Diagnostics"
            case .watchDetail: "Apple Watch"
            case .licenseDetail: "Licenses"
            case .headersDetail: "Gateway"
            default: nil
            }
        }
    }

    private func runNativeVisualProof(_ scenario: Scenario) async throws {
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
            "gateway.onboardingComplete": true, "gateway.hasConnectedOnce": true,
            "onboarding.quickSetupDismissed": true, "screen.preventSleep": false,
            "gateway.autoconnect": false, "gateway.manual.enabled": true,
            "gateway.manual.host": "navigation-\(UUID().uuidString.lowercased()).example",
            "gateway.manual.port": 443, "gateway.manual.tls": true,
            "watch.chat.command.queue.v1": nil, "watch.message.outbox.metadata.v1": nil,
        ]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            let router = NativeActionRouter(appModel: model, gatewayController: controller)
            let gatewayID = "visual-fixture-\(UUID().uuidString)"
            let session = OpenClawNativeSessionRef(
                owner: .init(gatewayID: gatewayID, profileID: "demo-account"),
                agentID: "main", sessionKey: "global")
            let run = OpenClawNativeRunRef(session: session, runID: "visual-run-a")
            var sends = 0
            var creates = 0
            var createdKeys: [String] = []
            var createEntered = false
            var completedCreateReplies = 0
            let createRelease = AsyncStream<Void>.makeStream()
            var creatingChat: OpenClawChatViewModel?
            var inspectedRuns: [[String]] = []
            var historyTargets: Set<String> = []
            var holdNativeHistory = false
            var historyEntered = false
            let historyRelease = AsyncStream<Void>.makeStream()
            var opening: Task<OpenClawNativeOpenOutcome, Never>?
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(role: "operator", scopes: ["operator.read", "operator.write"], capabilities: [
                    GatewayServerCapability.profileBinding.rawValue,
                    GatewayServerCapability.chatSendRoutingContract.rawValue,
                    GatewayServerCapability.sessionSettingsCAS.rawValue,
                ]),
                rpcHandler: { request in
                    let method = request["method"] as? String ?? ""
                    let params = request["params"] as? [String: Any] ?? [:]
                    let profile = request["expectedProfileId"] as? String
                    // RootTabs also owns ordinary UI reads on this connection. Inspection's
                    // inputRunIds request below must still carry its exact account binding.
                    XCTAssertTrue(profile == nil || profile == session.owner.profileID)
                    switch method {
                    case "users.self":
                        XCTAssertEqual(profile, session.owner.profileID)
                        return .success(["profile": ["id": session.owner.profileID]])
                    case "agents.list":
                        return .success([
                            "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                            "agents": [["id": "main", "name": "Main"], ["id": "research", "name": "Research"]],
                        ])
                    case "chat.history":
                        let key = params["sessionKey"] as? String ?? ""
                        let agent = params["agentId"] as? String ?? OpenClawChatSessionKey.agentID(from: key) ?? "main"
                        historyTargets.insert("\(agent)|\(key)")
                        if let runIDs = params["inputRunIds"] as? [String] {
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(runIDs, [run.runID])
                            XCTAssertEqual(key, session.sessionKey)
                            XCTAssertEqual(agent, session.agentID)
                            inspectedRuns.append(runIDs)
                        }
                        let response = NativeGatewayWebSocketFixture.RPCResponse.success([
                            "sessionKey": key, "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": agent, "sessionId": "visual-session-\(agent)",
                                "permissionMode": "guarded", "toolOverrides": [:],
                                "activeRunIds": agent == session.agentID && key == session
                                    .sessionKey ? [run.runID] : [],
                            ],
                        ])
                        if holdNativeHistory, profile == session.owner.profileID,
                           params["inputRunIds"] as? [String] == [run.runID]
                        {
                            holdNativeHistory = false
                            historyEntered = true
                            return .deferred {
                                for await _ in historyRelease.stream {
                                    break
                                }
                                return response
                            }
                        }
                        return response
                    case "sessions.list":
                        var sessions: [[String: Any]] = ["main", "research"].map {
                            [
                                "key": "global",
                                "agentId": $0,
                                "displayName": "\($0.capitalized) conversation",
                                "permissionMode": "guarded",
                                "toolOverrides": [:],
                            ]
                        }
                        sessions.append([
                            "key": "dashboard-fixture",
                            "agentId": "main",
                            "displayName": "Fixture dashboard",
                            "boardFace": "dashboard",
                        ])
                        return .success(["ts": 0, "count": sessions.count, "sessions": sessions])
                    case "sessions.messages.subscribe":
                        return .success(["subscribed": true, "key": params["key"] as? String ?? ""])
                    case "sessions.subscribe", "sessions.observer.visibility":
                        XCTAssertNil(profile)
                        return .success([:])
                    case "usage.cost":
                        XCTAssertNil(profile)
                        return .success(["daily": [], "totals": ["totalCost": 0]])
                    case "cron.list":
                        XCTAssertNil(profile)
                        return .success(["jobs": [], "total": 0, "hasMore": false])
                    case "health": return .success(["ok": true])
                    case "models.list": return .success(["models": []])
                    case "commands.list": return .success(["commands": []])
                    case "chat.metadata": return .success(["swarmEnabled": false])
                    case "tasks.list": return .success(["tasks": []])
                    case "chat.send":
                        sends += 1
                        XCTFail("Visual inspection must never send")
                        return .failure(code: "INVALID_REQUEST", message: "No send is permitted")
                    case "sessions.create":
                        creates += 1
                        if scenario == .sidebarFork {
                            XCTAssertNil(profile)
                            XCTAssertEqual(params["parentSessionKey"] as? String, session.sessionKey)
                            XCTAssertEqual(params["agentId"] as? String, session.agentID)
                            XCTAssertEqual(params["fork"] as? Bool, true)
                            return .success(["key": "agent:main:forked-visual"])
                        }
                        if scenario == .sidebarNewChat {
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(params["parentSessionKey"] as? String, session.sessionKey)
                            XCTAssertEqual(params["agentId"] as? String, session.agentID)
                            XCTAssertNil(params["fork"])
                            guard let key = params["key"] as? String, !key.isEmpty else {
                                completedCreateReplies += 1
                                XCTFail("Root New Chat omitted its generated key")
                                return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                            }
                            createdKeys.append(key)
                            return .deferred {
                                createEntered = true
                                defer { completedCreateReplies += 1 }
                                for await _ in createRelease.stream {
                                    break
                                }
                                return .success(["key": key])
                            }
                        }
                        XCTFail("Visual navigation must never create a session")
                        return .failure(code: "INVALID_REQUEST", message: "No session creation is permitted")
                    default:
                        XCTFail("Unexpected visual fixture method: \(method)")
                        return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method")
                    }
                })
            var window: UIWindow?
            var previousKeyWindow: UIWindow?
            let cleanup: () async -> Void = {
                historyRelease.continuation.finish()
                createRelease.continuation.finish()
                opening?.cancel()
                _ = await opening?.value
                // Restore before teardown, only while this fixture still owns key status.
                // A hidden predecessor or a newly installed key owner stays untouched.
                if let window, window.isKeyWindow, let scene = window.windowScene,
                   let previousKeyWindow, !previousKeyWindow.isHidden,
                   previousKeyWindow.windowScene === scene
                {
                    previousKeyWindow.makeKey()
                }
                window?.isHidden = true
                window?.rootViewController = nil
                window = nil
                previousKeyWindow = nil
                await model.operatorSession.disconnect()
                await fixture.stopAndWait()
                model.setOperatorConnected(false)
                model.activeGatewayConnectConfig = nil
                model.voiceWake.stop()
                if scenario == .sidebarNewChat {
                    do {
                        try await self.waitUntil {
                            creatingChat?.isCreatingSession != true &&
                                model.chatPresentation.viewModel?
                                .isCreatingSession != true && completedCreateReplies == creates
                        }
                    } catch {
                        XCTFail("Root New Chat did not finish; retaining fixture cache")
                        return
                    }
                }
                await model.purgeChatTranscriptCache(gatewayID: gatewayID)
            }
            do {
                var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
                options.allowStoredDeviceAuth = false
                options.deviceAuthGatewayID = gatewayID
                try await model.operatorSession.connect(
                    url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                    onConnected: {}, onDisconnected: { _ in }, onInvoke: { .init(id: $0.id, ok: true) })
                model.activeGatewayConnectConfig = GatewayConnectConfig(
                    url: fixture.url(), stableID: gatewayID, tls: nil, token: nil,
                    bootstrapToken: nil, password: nil, nodeOptions: options)
                model.connectedGatewayID = gatewayID
                model.gatewayServerName = "Demo Gateway"
                model.setOperatorConnected(true)
                let root = RootTabs(initialSidebarVisibility: false)
                    .environment(AppAppearanceModel())
                    .environment(model)
                    .environment(model.voiceWake)
                    .environment(controller)
                    .environment(router)
                    .environment(\.scenePhase, .active)
                    .preferredColorScheme(.light)
                let hosting = UIHostingController(rootView: root)
                let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                    .filter { $0.activationState == .foregroundActive }
                XCTAssertEqual(scenes.count, 1)
                guard scenes.count == 1 else { throw OpenClawNativeActionError("Native visual scene is ambiguous") }
                let scene = try XCTUnwrap(scenes.first)
                previousKeyWindow = scene.windows.first { $0.isKeyWindow && !$0.isHidden }
                let ownedWindow = UIWindow(windowScene: scene)
                ownedWindow.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window = ownedWindow
                ownedWindow.rootViewController = hosting
                ownedWindow.makeKeyAndVisible()
                hosting.view.layoutIfNeeded()
                // Open waits for RootTabs' real onAppear registration, after its initial
                // session adoption. No test presentation handler or demo mode is used.
                XCTAssertEqual(UIApplication.shared.applicationState, .active)
                let opened = await router.open(.session(session))
                XCTAssertEqual(opened, .opened)
                guard opened == .opened else { throw OpenClawNativeActionError("Visual chat did not open") }
                XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                try await self.waitForComposer(in: ownedWindow)
                XCTAssertNil(hosting.presentedViewController)
                if scenario == .sidebarNewChat {
                    let chat = try XCTUnwrap(model.chatPresentation.viewModel)
                    creatingChat = chat
                    XCTAssertEqual(model.chatPresentation.transport?.nativeBinding?.session, session)
                    // Retain the actual native model when the user event clears Root's binding.
                    chat.input = "retained Root New Chat draft"
                    let previousRequest = model.newChatRequestID
                    try await self.showSidebar(in: ownedWindow)
                    try await self.activateLabel(String(localized: "New Chat"), in: ownedWindow)
                    let request = model.newChatRequestID
                    XCTAssertEqual(request, previousRequest + 1)
                    try await self.waitUntil { createEntered && chat.isCreatingSession }
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(creates, 1)
                    XCTAssertFalse(model.consumeNewChatRequest(request))
                    XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                    let created = try XCTUnwrap(createdKeys.first)
                    XCTAssertNotEqual(created, session.sessionKey)
                    createRelease.continuation.finish()
                    // This is the real model operation's terminal/adoption signal;
                    // Root's SwiftUI task handle and registration ordering are not exposed.
                    try await self.waitUntil {
                        completedCreateReplies == creates && !chat.isCreatingSession &&
                            model.chatSessionKey == created &&
                            model.chatPresentation.viewModel?.currentSessionTarget.sessionKey == created &&
                            model.chatPresentation.viewModel?.isCreatingSession == false
                    }
                    try await self.waitForComposer(in: ownedWindow)
                    XCTAssertEqual(createdKeys, [created])
                    XCTAssertEqual(creates, 1)
                    XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                    XCTAssertNil(chat.errorText)
                    XCTAssertNil(model.chatPresentation.viewModel?.errorText)
                    XCTAssertEqual(sends, 0)
                    await cleanup()
                    return
                }
                if scenario != .inspection {
                    try await self.selectSidebarDestination(scenario.initialDestination, in: ownedWindow)
                    try await self.waitUntil { router.chatRegistrationID == nil }
                    if ["settings", "usage"].contains(scenario.initialDestination) {
                        try await self.waitForNavigationTitle("Settings", in: ownedWindow)
                    } else {
                        try await self.waitUntil {
                            try self.accessibilityElement(
                                nil,
                                label: "Gateway settings",
                                in: ownedWindow,
                                button: true) != nil
                        }
                    }
                    if let panel = scenario.initialPanel {
                        try await self.activateLabel(panel, in: ownedWindow)
                        try await self.waitForNavigationTitle(panel, in: ownedWindow)
                    }
                    if scenario == .sidebarFork {
                        try await self.showSidebar(in: ownedWindow)
                        let row = try XCTUnwrap(self.accessibilityElement(
                            nil, label: "Main conversation", prefix: true, in: ownedWindow, button: true))
                        let actions = row.accessibilityCustomActions ?? []
                        guard actions.count <= 16
                        else { throw OpenClawNativeActionError("Too many native custom actions") }
                        let forks = actions.filter { $0.name == String(localized: "Fork") }
                        let fork = try XCTUnwrap(forks.count == 1 ? forks.first : nil)
                        let perform = try XCTUnwrap(fork.actionHandler)
                        guard perform(fork)
                        else { throw OpenClawNativeActionError("Native Fork action did not activate") }
                        try await self.waitUntil { model.chatSessionKey == "agent:main:forked-visual" }
                        try await self.waitForComposer(in: ownedWindow)
                        XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                        XCTAssertEqual(creates, 1)
                        XCTAssertEqual(sends, 0)
                        await cleanup()
                        return
                    }
                    if scenario == .nativeFromSettingsPath || scenario == .nativeAfterUserChat {
                        if scenario == .nativeAfterUserChat {
                            try await self.showSidebar(in: ownedWindow)
                            let home = try XCTUnwrap(self.accessibilityElement(
                                "RootTabs.Sidebar.Destination.chat", in: ownedWindow, button: true))
                            guard home.accessibilityActivate() else {
                                throw OpenClawNativeActionError("Native Home action did not activate")
                            }
                            // Start before SwiftUI delivers the UI request's onChange.
                        }
                        let reopened = await router.open(.session(session))
                        XCTAssertEqual(reopened, .opened)
                        try await self.waitForComposer(in: ownedWindow)
                        let inspected = try await router.inspect(run)
                        XCTAssertEqual(inspected.run, run)
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)
                        await cleanup()
                        return
                    }
                    var dismissalSheet: UIViewController?
                    if scenario == .sheetDone || scenario == .sheetEscape {
                        try await self.showSidebar(in: ownedWindow)
                        try await self.activateLabel("Fixture dashboard", in: ownedWindow, prefix: true)
                        try await self.waitUntil {
                            guard hosting.presentedViewController?.view.window === ownedWindow else { return false }
                            return try self
                                .accessibilityElement(nil, label: "Done", in: ownedWindow, button: true) != nil
                        }
                        dismissalSheet = try XCTUnwrap(hosting.presentedViewController)
                    }
                    let sessionKey = model.chatSessionKey
                    let agentID = model.chatDeliveryAgentId
                    holdNativeHistory = true
                    let task = Task { await router.open(.inspect(run)) }
                    opening = task
                    // The account-bound history is physically held before the real
                    // user control fires. No direct root callback substitutes for UI.
                    try await self.waitUntil { historyEntered }
                    var finalTitle: String?
                    switch scenario {
                    case .sidebarChoice, .sidebarABA:
                        if scenario == .sidebarABA {
                            try await self.selectSidebarDestination("overview", in: ownedWindow)
                        }
                        try await self.selectSidebarDestination("settings", in: ownedWindow)
                        finalTitle = "Settings"
                    case .overviewGear:
                        try await self.activateLabel("Gateway settings", in: ownedWindow)
                        finalTitle = "Gateway"
                    case .sameKeySession:
                        try await self.showSidebar(in: ownedWindow)
                        try await self.activateLabel("Main conversation", in: ownedWindow, prefix: true)
                        try await self.waitForComposer(in: ownedWindow)
                    case .settingsPush, .settingsABA, .dashboardPush:
                        try await self.activateLabel("Diagnostics", in: ownedWindow)
                        try await self.waitForNavigationTitle("Diagnostics", in: ownedWindow)
                        if scenario == .settingsABA {
                            try await self.activateBack(from: "Diagnostics", to: "Settings", in: ownedWindow)
                            finalTitle = "Settings"
                        } else { finalTitle = "Diagnostics" }
                    case .settingsPop, .dashboardPop:
                        try await self.activateBack(from: "Diagnostics", to: "Settings", in: ownedWindow)
                        finalTitle = "Settings"
                    case .watchDetail:
                        try await self.activateLabel("Message Delivery", in: ownedWindow)
                        finalTitle = "Message Delivery"
                    case .licenseDetail:
                        let document = try XCTUnwrap(LicenseDocumentLoader.bundledDocuments().first)
                        try await self.activateLabel(document.title, in: ownedWindow)
                        finalTitle = document.title
                    case .headersDetail:
                        // This is the isolated manual TLS target, not a relabeled ws socket.
                        try await self.activateLabel("Custom Headers", in: ownedWindow)
                        finalTitle = "Custom Headers"
                    case .logsDetail:
                        try await self.activateLabel("Discovery Logs", in: ownedWindow, prefix: true)
                        finalTitle = "Discovery Logs"
                    case .sheetDone, .sheetEscape:
                        let sheet = try XCTUnwrap(dismissalSheet)
                        guard hosting.presentedViewController === sheet, sheet.view.window === ownedWindow else {
                            throw OpenClawNativeActionError("Owned dismissal sheet changed during native history")
                        }
                        if scenario == .sheetDone {
                            try await self.activateLabel("Done", in: ownedWindow)
                        } else {
                            guard sheet.view.accessibilityPerformEscape() else {
                                throw OpenClawNativeActionError("Owned sheet did not accept accessibility dismissal")
                            }
                        }
                        try await self.waitUntil { hosting.presentedViewController == nil }
                        try await self.waitUntil {
                            try self.accessibilityElement(
                                nil,
                                label: "Gateway settings",
                                in: ownedWindow,
                                button: true) != nil
                        }
                    case .externalDashboard:
                        try await model.handleDeepLink(url: XCTUnwrap(URL(string: "openclaw://dashboard")))
                        try await self.waitUntil {
                            try self.accessibilityElement(
                                nil,
                                label: "Gateway settings",
                                in: ownedWindow,
                                button: true) != nil
                        }
                    case .inspection, .nativeFromSettingsPath, .nativeAfterUserChat, .sidebarFork, .sidebarNewChat:
                        XCTFail("Unexpected held-history scenario")
                    }
                    if let finalTitle { try await self.waitForNavigationTitle(finalTitle, in: ownedWindow) }
                    historyRelease.continuation.finish()
                    let result = await task.value
                    XCTAssertEqual(result, .cancelled)
                    if let finalTitle { try await self.waitForNavigationTitle(finalTitle, in: ownedWindow) }
                    if scenario != .sameKeySession { XCTAssertNil(router.chatRegistrationID) }
                    XCTAssertNil(hosting.presentedViewController)
                    XCTAssertEqual(model.chatSessionKey, sessionKey)
                    XCTAssertEqual(model.chatDeliveryAgentId, agentID)
                    XCTAssertEqual(inspectedRuns, [[run.runID]])
                    XCTAssertEqual(sends, 0)
                    XCTAssertEqual(creates, 0)
                    await cleanup()
                    return
                }
                try self.attach(ownedWindow, name: "native-action-before-inspection")

                // This awaited call only returns after the actual Run sheet acknowledges
                // its exact presentation identity through onAppear.
                let inspection = try await router.inspect(run)
                XCTAssertEqual(inspection.run, run)
                XCTAssertEqual(inspection.summary, "Active.")
                try await self.waitUntil { hosting.presentedViewController?.view.window === ownedWindow }
                try self.attach(ownedWindow, name: "native-action-after-inspection")

                model.focusChatSession(.init(sessionKey: "global", agentID: "research"))
                try await self.waitUntil {
                    hosting.presentedViewController == nil && model.chatSessionKey == "global" &&
                        model.chatDeliveryAgentId == "research" && historyTargets.contains("research|global")
                }
                try self.attach(ownedWindow, name: "native-action-after-agent-change")
                XCTAssertEqual(inspectedRuns, [[run.runID]])
                XCTAssertEqual(sends, 0)
                await cleanup()
            } catch {
                await cleanup()
                throw error
            }
        }
    }

    private func showSidebar(in window: UIWindow) async throws {
        let show = try XCTUnwrap(self.accessibilityElement("RootTabs.Sidebar.Show", in: window, button: true))
        guard show.accessibilityActivate() else {
            throw OpenClawNativeActionError("Native sidebar action did not activate")
        }
        try await self.waitUntil {
            try self.accessibilityElement("RootTabs.Sidebar.Destination.settings", in: window, button: true) != nil
        }
    }

    private func activateLabel(_ label: String, in window: UIWindow, prefix: Bool = false) async throws {
        for _ in 0..<8 {
            if let action = try self.accessibilityElement(nil, label: label, prefix: prefix, in: window, button: true) {
                guard action.accessibilityActivate() else {
                    throw OpenClawNativeActionError("Native navigation control did not activate")
                }
                return
            }
            let scrolls = try self.visibleViews(in: window).compactMap { $0 as? UIScrollView }.filter {
                $0.isScrollEnabled && $0.contentSize.height > $0.bounds.height &&
                    $0.convert($0.bounds, to: window).intersects(window.bounds)
            }
            let scroll = try XCTUnwrap(scrolls.count == 1 ? scrolls.first : nil)
            let before = scroll.contentOffset
            guard scroll.accessibilityScroll(.down) else {
                throw OpenClawNativeActionError("Native navigation list did not scroll")
            }
            try await self.waitUntil { scroll.contentOffset != before }
        }
        throw OpenClawNativeActionError("Native navigation control was not found")
    }

    private func visibleViews(in window: UIWindow) throws -> [UIView] {
        guard window.isKeyWindow, !window.isHidden else { throw CancellationError() }
        var pending: [UIView] = [window]
        var result: [UIView] = []
        var seen: Set<ObjectIdentifier> = []
        while let view = pending.popLast() {
            guard seen.insert(ObjectIdentifier(view)).inserted, !view.isHidden, view.alpha > 0,
                  view === window || view.window === window else { continue }
            guard seen.count <= 512 else { throw OpenClawNativeActionError("Native view hierarchy exceeds its bound") }
            result.append(view)
            pending.append(contentsOf: view.subviews)
        }
        return result
    }

    private func waitForNavigationTitle(_ title: String, in window: UIWindow) async throws {
        try await self.waitUntil {
            try self.visibleViews(in: window).compactMap { $0 as? UINavigationBar }
                .filter { $0.topItem?.title == title }.count == 1
        }
    }

    private func activateBack(from title: String, to previous: String, in window: UIWindow) async throws {
        let bars = try self.visibleViews(in: window).compactMap { $0 as? UINavigationBar }
            .filter { $0.topItem?.title == title }
        let bar = try XCTUnwrap(bars.count == 1 ? bars.first : nil)
        let backTitle = try XCTUnwrap(bar.backItem?.backButtonTitle ?? bar.backItem?.title)
        let named = try self.accessibilityElement(nil, label: backTitle, in: window, button: true)
        let back = try XCTUnwrap(named ?? self.accessibilityElement(
            nil, label: String(localized: "Back"), in: window, button: true))
        guard back.accessibilityActivate() else {
            throw OpenClawNativeActionError("Native Back control did not activate")
        }
        try await self.waitForNavigationTitle(previous, in: window)
    }

    private func selectSidebarDestination(_ destination: String, in window: UIWindow) async throws {
        if let show = try self.accessibilityElement("RootTabs.Sidebar.Show", in: window, button: true) {
            guard show.accessibilityActivate() else {
                throw OpenClawNativeActionError("Native sidebar action did not activate")
            }
        }
        let identifier = "RootTabs.Sidebar.Destination.\(destination)"
        try await self.waitUntil {
            try self.accessibilityElement(identifier, in: window, button: true) != nil
        }
        let action = try XCTUnwrap(self.accessibilityElement(identifier, in: window, button: true))
        guard action.accessibilityActivate() else {
            throw OpenClawNativeActionError("Native sidebar destination did not activate")
        }
        // Phone drawer selection closes the real sidebar before another action
        // can be addressed. Never replace a missing element with a direct callback.
        try await self.waitUntil {
            try self.accessibilityElement("RootTabs.Sidebar.Show", in: window, button: true) != nil
        }
    }

    private func accessibilityElement(
        _ identifier: String?,
        label: String? = nil,
        prefix: Bool = false,
        in window: UIWindow,
        button: Bool = false) throws -> NSObject?
    {
        guard !window.isHidden, window.isKeyWindow else {
            throw OpenClawNativeActionError("Native visual window lost ownership")
        }
        let bounds = window.convert(window.bounds, to: nil as UIWindow?)
        var pending: [NSObject] = [window]
        var discovered: Set<ObjectIdentifier> = [ObjectIdentifier(window)]
        var matches: [NSObject] = []
        func enqueue(_ child: NSObject) throws {
            guard discovered.insert(ObjectIdentifier(child)).inserted else { return }
            guard discovered.count <= 512 else {
                throw OpenClawNativeActionError("Native visual accessibility hierarchy exceeds its bound")
            }
            pending.append(child)
        }
        while let element = pending.popLast() {
            guard !element.accessibilityElementsHidden else { continue }
            if let view = element as? UIView {
                guard view === window || view.window === window, !view.isHidden, view.alpha > 0 else { continue }
                for child in view.subviews {
                    try enqueue(child)
                }
            }
            let matchesIdentifier = identifier != nil &&
                (element as? UIAccessibilityIdentification)?.accessibilityIdentifier == identifier
            let matchesLabel = label.map { prefix ? (element.accessibilityLabel?.hasPrefix($0) == true) :
                element.accessibilityLabel == $0
            } ?? false
            if matchesIdentifier || matchesLabel,
               !element.accessibilityFrame.isEmpty, bounds.intersects(element.accessibilityFrame),
               !button || (element.accessibilityTraits.contains(.button) &&
                   !element.accessibilityTraits.contains(.notEnabled))
            {
                matches.append(element)
            }
            if let children = element.accessibilityElements {
                guard children.count <= 512 else {
                    throw OpenClawNativeActionError("Native visual accessibility container exceeds its bound")
                }
                for child in children {
                    if let child = child as? NSObject { try enqueue(child) }
                }
            } else {
                let count = element.accessibilityElementCount()
                if count == NSNotFound { continue }
                guard (0...512).contains(count) else {
                    throw OpenClawNativeActionError("Native visual accessibility container exceeds its bound")
                }
                for index in 0..<count {
                    if let child = element.accessibilityElement(at: index) as? NSObject { try enqueue(child) }
                }
            }
        }
        guard matches.count <= 1 else {
            throw OpenClawNativeActionError("Native visual accessibility target is ambiguous")
        }
        return matches.first
    }

    private func waitForComposer(in window: UIWindow) async throws {
        // Router readiness precedes UIKit materialization. Capture only after the
        // owned window contains the actual empty editor for this no-draft fixture.
        try await self.waitUntil {
            var pending: [UIView] = [window]
            var inputs: [ChatComposerUITextView] = []
            var visited = 0
            while let view = pending.popLast() {
                visited += 1
                guard visited <= 512 else {
                    throw OpenClawNativeActionError("Native visual hierarchy exceeds its bound")
                }
                if let input = view as? ChatComposerUITextView { inputs.append(input) }
                pending.append(contentsOf: view.subviews)
            }
            guard inputs.count <= 1 else {
                throw OpenClawNativeActionError("Native visual editor is ambiguous")
            }
            guard let input = inputs.first else { return false }
            return input.window === window && input.bounds.width > 0 && input.bounds.height > 0 &&
                (input.text ?? "").utf8.isEmpty
        }
    }

    private func waitUntil(_ ready: @MainActor () throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while try !ready(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard try ready() else { throw OpenClawNativeActionError("Native visual presentation did not settle") }
    }

    private func attach(_ window: UIWindow, name: String) throws {
        XCTAssertFalse(window.isHidden)
        window.layoutIfNeeded()
        var rendered = false
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard rendered else { throw OpenClawNativeActionError("Native window capture failed") }
        let attachment = XCTAttachment(image: image, quality: .original)
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
