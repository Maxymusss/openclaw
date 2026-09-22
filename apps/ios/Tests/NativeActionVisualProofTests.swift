import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit
import UserNotifications
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
final class NativeActionVisualProofTests: XCTestCase {
    /// Preserve failed fixture ownership and the pre-test bridge snapshot until the test process ends.
    private static var retainedApprovalFixtures: [
        (model: NodeAppModel, gatewayID: String, deviceID: String?, bridgeState: Any?)
    ] = []

    func testInspectionRetiresWhenSelectedAgentChanges() async throws {
        try await self.runNativeVisualProof(.inspection)
    }

    func testClosingRunInspectionCancelsHeldSameRunReopen() async throws {
        for scenario in [Scenario.inspectionDone, .inspectionEscape] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testNativeSameRunInspectionReplacementKeepsPresentationAuthority() async throws {
        try await self.runNativeVisualProof(.inspectionReplacement)
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

    func testGatewayProblemDetailsPreservesSelectionUntilDismissed() async throws {
        try await self.runNativeVisualProof(.gatewayDetails)
    }

    func testApprovalDashboardPreservesSelectionUntilPromptDismissed() async throws {
        try await self.runNativeVisualProof(.approvalDashboard)
    }

    func testNotificationGuidancePreservesSelectionUntilDismissed() async throws {
        try await self.runNativeVisualProof(.notificationGuidance)
    }

    func testAgentDeepLinkPromptPreservesSelectionUntilDismissed() async throws {
        try await self.runNativeVisualProof(.agentDeepLink)
    }

    func testGatewayTrustPromptPreservesSelectionUntilDismissed() async throws {
        try await self.runNativeVisualProof(.gatewayTrust)
    }

    func testSidebarNewChatUsesRootOperationTask() async throws {
        for scenario in [Scenario.sidebarNewChat, .sidebarNewChatProtected, .sidebarNewChatOrdinary] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testNativeForkPreservesEditorAndAdoptsSuccessorAuthority() async throws {
        for scenario in [Scenario.nativeForkCanonical, .nativeForkOpaque] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testHeldNativeSessionAdoptionCannotOutliveItsOrigin() async throws {
        for scenario in [
            Scenario.nativeForkNavigation, .nativeForkAccountABA, .nativeForkRoute, .nativeCreateAccountABA,
        ] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testNativeAccountABARetiresHeldPresentationAndPreparedConfirmation() async throws {
        for scenario in [
            Scenario.nativeOpenAccountABA, .nativeInspectAccountABA, .nativePreparedSendAccountABA,
        ] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testChatOwnedSheetsRefuseNativeMutationBeforeSelection() async throws {
        for scenario in [Scenario.chatModalAdmissionApp, .chatModalAdmissionShared] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testChatOwnedSheetOpenDismissRetiresHeldNativeWork() async throws {
        for scenario in [
            Scenario.chatModalHeldOpenApp, .chatModalHeldOpenShared,
            .chatModalHeldInspectApp, .chatModalHeldInspectShared,
            .chatModalHeldPrepareApp, .chatModalHeldPrepareShared,
        ] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testChatOwnedSheetRetiresConfirmationAndFreshSendSucceeds() async throws {
        for scenario in [Scenario.chatModalPreparedApp, .chatModalPreparedShared] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testRemovingRootWithChatModalReleasesExactRegistrations() async throws {
        for scenario in [Scenario.chatModalRemovalApp, .chatModalRemovalShared] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testNativeNewSessionOptionsRetainsOwnerAcrossFullScreenCoverAndRetry() async throws {
        try await self.runNativeVisualProof(.chatModalNewOptionsCover)
    }

    func testPagesEditorRefusesNativeMutationAndPreservesNavigation() async throws {
        for scenario in [Scenario.pagesAdmission, .pagesAdmissionCover] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testPagesEditorOpenDismissRetiresHeldNativeWork() async throws {
        for scenario in [Scenario.pagesHeldOpen, .pagesHeldInspect, .pagesHeldPrepare] {
            try await self.runNativeVisualProof(scenario)
        }
    }

    func testPagesEditorRetiresConfirmationAndFreshSendSucceeds() async throws {
        try await self.runNativeVisualProof(.pagesPrepared)
    }

    func testRemovingRootWithPagesEditorReleasesRegistration() async throws {
        try await self.runNativeVisualProof(.pagesRemoval)
    }

    private enum Scenario: Sendable {
        case inspection, inspectionDone, inspectionEscape, inspectionReplacement
        case sidebarChoice
        case sidebarABA
        case overviewGear, sameKeySession, settingsPush, settingsPop, settingsABA
        case dashboardPush, dashboardPop, watchDetail, licenseDetail, headersDetail, logsDetail
        case sheetDone, sheetEscape, externalDashboard, gatewayDetails
        case approvalDashboard, notificationGuidance, agentDeepLink, gatewayTrust
        case nativeFromSettingsPath, nativeAfterUserChat, sidebarFork, sidebarNewChat
        case sidebarNewChatProtected, sidebarNewChatOrdinary
        case nativeForkCanonical, nativeForkOpaque, nativeForkNavigation, nativeForkAccountABA, nativeForkRoute
        case nativeCreateAccountABA
        case nativeOpenAccountABA, nativeInspectAccountABA, nativePreparedSendAccountABA
        case chatModalAdmissionApp, chatModalAdmissionShared
        case chatModalHeldOpenApp, chatModalHeldOpenShared, chatModalHeldInspectApp, chatModalHeldInspectShared
        case chatModalHeldPrepareApp, chatModalHeldPrepareShared, chatModalPreparedApp, chatModalPreparedShared
        case chatModalNewOptionsCover, chatModalRemovalApp, chatModalRemovalShared

        case pagesAdmission, pagesAdmissionCover, pagesHeldOpen, pagesHeldInspect, pagesHeldPrepare
        case pagesPrepared, pagesRemoval

        var testsPagesEditor: Bool {
            switch self {
            case .pagesAdmission, .pagesAdmissionCover, .pagesHeldOpen, .pagesHeldInspect, .pagesHeldPrepare,
                 .pagesPrepared, .pagesRemoval: true
            default: false
            }
        }

        var testsSidebarNewChat: Bool {
            switch self {
            case .sidebarNewChat, .sidebarNewChatProtected, .sidebarNewChatOrdinary: true
            default: false
            }
        }

        var testsChatModal: Bool {
            switch self {
            case .chatModalAdmissionApp, .chatModalAdmissionShared, .chatModalHeldOpenApp, .chatModalHeldOpenShared,
                 .chatModalHeldInspectApp, .chatModalHeldInspectShared, .chatModalHeldPrepareApp,
                 .chatModalHeldPrepareShared, .chatModalPreparedApp, .chatModalPreparedShared,
                 .chatModalNewOptionsCover, .chatModalRemovalApp, .chatModalRemovalShared: true
            default: false
            }
        }

        var usesSharedChatModal: Bool {
            switch self {
            case .chatModalAdmissionShared, .chatModalHeldOpenShared, .chatModalHeldInspectShared,
                 .chatModalHeldPrepareShared, .chatModalPreparedShared, .chatModalRemovalShared: true
            default: false
            }
        }

        var testsNativeAdoption: Bool {
            switch self {
            case .nativeForkCanonical, .nativeForkOpaque, .nativeForkNavigation, .nativeForkAccountABA,
                 .nativeForkRoute, .nativeCreateAccountABA: true
            default: false
            }
        }

        var holdsNativeAdoption: Bool {
            switch self {
            case .nativeForkNavigation, .nativeForkAccountABA, .nativeForkRoute, .nativeCreateAccountABA: true
            default: false
            }
        }

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
        guard Self.retainedApprovalFixtures.isEmpty else {
            throw OpenClawNativeActionError("A prior approval fixture has incomplete cleanup")
        }
        var defaults: [String: Any?] = [
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
            "gateway.onboardingComplete": true, "gateway.hasConnectedOnce": true,
            "onboarding.quickSetupDismissed": true, "screen.preventSleep": false,
            "gateway.autoconnect": false, "gateway.manual.enabled": true,
            "gateway.manual.host": "navigation-\(UUID().uuidString.lowercased()).example",
            "gateway.manual.port": 443, "gateway.manual.tls": true,
            "watch.chat.command.queue.v1": nil, "watch.message.outbox.metadata.v1": nil,
        ]
        let hasApprovalFixture = scenario == .approvalDashboard || scenario == .notificationGuidance
        if hasApprovalFixture {
            defaults["notifications.execApprovalGuidance.suppressed"] = false
        }
        if scenario == .gatewayTrust {
            defaults["node.instanceId"] = UUID().uuidString
        }
        if scenario.testsPagesEditor {
            defaults["sidebar.pinnedPages"] = "overview,usage"
        }
        try await withUserDefaults(defaults) {
            let bridgeKey = "watch.execApproval.bridge.state.v1"
            let previousBridgeState = hasApprovalFixture ? UserDefaults.standard.object(forKey: bridgeKey) : nil
            var restoreBridgeState = true
            if hasApprovalFixture { UserDefaults.standard.removeObject(forKey: bridgeKey) }
            defer {
                if hasApprovalFixture, restoreBridgeState {
                    if let previousBridgeState {
                        UserDefaults.standard.set(previousBridgeState, forKey: bridgeKey)
                    } else {
                        UserDefaults.standard.removeObject(forKey: bridgeKey)
                    }
                }
            }
            let model = if hasApprovalFixture {
                NodeAppModel(
                    notificationCenter: DeniedVisualNotificationCenter(), audioAdmissionInitiallyAllowed: false)
            } else {
                NodeAppModel(audioAdmissionInitiallyAllowed: false)
            }
            let controller = if scenario == .gatewayTrust {
                GatewayConnectionController(
                    appModel: model, startDiscovery: false,
                    tcpReachabilityProbe: { _, _, _, _ in true },
                    tlsFingerprintProbe: { _ in .fingerprint("visual-trust-fingerprint") },
                    serviceEndpointResolver: { _ in (host: "127.0.0.1", port: 1) })
            } else {
                GatewayConnectionController(appModel: model, startDiscovery: false)
            }
            let router = NativeActionRouter(appModel: model, gatewayController: controller)
            let gatewayID = "visual-fixture-\(UUID().uuidString)"
            let session = OpenClawNativeSessionRef(
                owner: .init(gatewayID: gatewayID, profileID: "demo-account"),
                agentID: "main", sessionKey: "global")
            let run = OpenClawNativeRunRef(session: session, runID: "visual-run-a")
            var sends = 0
            var permitsModalSend = false
            var preparingModal: Task<OpenClawNativePreparedSend, Error>?
            var creates = 0
            var createdKeys: [String] = []
            var createEntered = false
            var completedCreateReplies = 0
            let createRelease = AsyncStream<Void>.makeStream()
            var creatingChat: OpenClawChatViewModel?
            let forkImage = Data("native fork image".utf8)
            let firstForkKey = scenario == .nativeForkCanonical ? "agent:main:visual-fork" : "opaque-visual-fork"
            var forkKeys: [String] = []
            var forkTargets: [OpenClawChatSessionTarget] = []
            var resetTargets: [OpenClawChatSessionTarget] = []
            var adoptionEntered = false
            let adoptionRelease = AsyncStream<Void>.makeStream()
            var forking: Task<Void, Never>?
            var creating: Task<Bool, Never>?
            var inspectedRuns: [[String]] = []
            var historyTargets: Set<String> = []
            var modalHistoryReads: [(key: String, agent: String, profile: String?)] = []
            var heldPagesHistory: (key: String, agent: String, profile: String?, runIDs: [String]?)?
            var holdNativeHistory = false
            var holdAnyNativeHistory = false
            var historyEntered = false
            let historyRelease = AsyncStream<Void>.makeStream()
            var opening: Task<OpenClawNativeOpenOutcome, Never>?
            let approvalID = UUID().uuidString
            let approvalToken = "visual-operator-token"
            var approvalDeviceID: String?
            var approvalTerminalJSON: String?
            let approvalEvent = ApprovalEventState()
            let approvalRelease = AsyncStream<Void>.makeStream()
            var approvalEventTask: Task<Void, Never>?
            let originalNodeConnected = model.gatewayConnected
            var ownedDeepLinkPromptID: String?
            let trustGatewayID = "visual-trust-\(UUID().uuidString)"
            var ownedTrustPrompt: GatewayConnectionController.TrustPrompt?
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
                        if scenario.testsChatModal { modalHistoryReads.append((key, agent, profile)) }
                        if let runIDs = params["inputRunIds"] as? [String] {
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(runIDs, [run.runID])
                            XCTAssertEqual(key, session.sessionKey)
                            if scenario.testsChatModal || scenario.testsPagesEditor {
                                XCTAssertTrue([session.agentID, "research"].contains(agent))
                            } else {
                                XCTAssertEqual(agent, session.agentID)
                            }
                            inspectedRuns.append(runIDs)
                        }
                        var history: [String: Any] = [
                            "sessionKey": key, "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": agent, "sessionId": "visual-session-\(agent)",
                                "permissionMode": "guarded", "toolOverrides": [:],
                                "activeRunIds": !scenario
                                    .testsNativeAdoption && !scenario.testsChatModal && !scenario.testsPagesEditor &&
                                    !scenario.testsSidebarNewChat &&
                                    scenario != .nativePreparedSendAccountABA &&
                                    agent == session.agentID && key == session
                                    .sessionKey ? [run.runID] : [],
                            ],
                        ]
                        if scenario.testsNativeAdoption || scenario.testsChatModal || scenario.testsPagesEditor ||
                            scenario.testsSidebarNewChat ||
                            scenario == .nativePreparedSendAccountABA
                        {
                            // These confirmations must otherwise reach chat.send: exact settings
                            // admission needs a coherent full-row/header durable identity.
                            history["sessionId"] = "visual-session-\(agent)"
                        }
                        if scenario.testsChatModal {
                            history["messages"] = [[
                                "role": "assistant", "content": [["type": "text", "text": "A captured modal answer."]],
                                "timestamp": 1, "stopReason": "stop",
                            ]]
                        }
                        let response = NativeGatewayWebSocketFixture.RPCResponse.success(history)
                        if holdNativeHistory, profile == session.owner.profileID,
                           !(scenario.testsChatModal || scenario.testsPagesEditor) ||
                           (params["limit"] as? Int == 100 && params["maxChars"] as? Int == 2000),
                           holdAnyNativeHistory || params["inputRunIds"] as? [String] == [run.runID]
                        {
                            holdNativeHistory = false
                            if scenario.testsPagesEditor {
                                heldPagesHistory = (key, agent, profile, params["inputRunIds"] as? [String])
                            }
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
                        if scenario.testsChatModal || scenario.testsPagesEditor, permitsModalSend {
                            permitsModalSend = false
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(params["sessionKey"] as? String, session.sessionKey)
                            XCTAssertEqual(params["agentId"] as? String, session.agentID)
                            guard let requestID = params["idempotencyKey"] as? String else {
                                return .failure(code: "INVALID_REQUEST", message: "Missing invocation key")
                            }
                            return .success(["runId": requestID, "status": "ok"])
                        }
                        XCTFail("Visual inspection must never send")
                        return .failure(code: "INVALID_REQUEST", message: "No send is permitted")
                    case "sessions.fork":
                        guard scenario.testsNativeAdoption else {
                            XCTFail("Unexpected message fork")
                            return .failure(code: "INVALID_REQUEST", message: "Unexpected message fork")
                        }
                        XCTAssertEqual(profile, session.owner.profileID)
                        let key = params["sessionKey"] as? String ?? ""
                        let agent = params["agentId"] as? String ?? OpenClawChatSessionKey.agentID(from: key)
                        forkTargets.append(.init(sessionKey: key, agentID: agent))
                        XCTAssertEqual(params["entryId"] as? String, "visual-user-message")
                        let child = forkKeys.isEmpty ? firstForkKey : "opaque-visual-second-fork"
                        forkKeys.append(child)
                        let response = NativeGatewayWebSocketFixture.RPCResponse.success([
                            "sessionKey": child, "editorText": "restored fork draft",
                            "editorAttachments": [["mimeType": "image/webp", "data": forkImage.base64EncodedString()]],
                        ])
                        if scenario.holdsNativeAdoption {
                            adoptionEntered = true
                            return .deferred {
                                for await _ in adoptionRelease.stream {
                                    break
                                }
                                return response
                            }
                        }
                        return response
                    case "sessions.reset":
                        guard scenario.testsNativeAdoption else {
                            XCTFail("Unexpected session reset")
                            return .failure(code: "INVALID_REQUEST", message: "Unexpected reset")
                        }
                        XCTAssertEqual(profile, session.owner.profileID)
                        resetTargets.append(.init(
                            sessionKey: params["key"] as? String ?? "",
                            agentID: params["agentId"] as? String))
                        return .success([:])
                    case "sessions.create":
                        creates += 1
                        if scenario == .chatModalNewOptionsCover {
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(params["agentId"] as? String, session.agentID)
                            guard let key = params["key"] as? String, !key.isEmpty else {
                                return .failure(code: "INVALID_REQUEST", message: "Missing key")
                            }
                            createdKeys.append(key)
                            if creates == 1 {
                                return .failure(code: "UNAVAILABLE", message: "Fixture creation refused; retry.")
                            }
                            return .success(["key": key])
                        }
                        if scenario.testsNativeAdoption {
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(params["agentId"] as? String, session.agentID)
                            XCTAssertNil(params["fork"])
                            guard let key = params["key"] as? String, !key.isEmpty else {
                                XCTFail("Native create omitted its key")
                                return .failure(code: "INVALID_REQUEST", message: "Missing key")
                            }
                            createdKeys.append(key)
                            if scenario == .nativeCreateAccountABA {
                                adoptionEntered = true
                                return .deferred {
                                    for await _ in adoptionRelease.stream {
                                        break
                                    }
                                    return .success(["key": key])
                                }
                            }
                            return .success(["key": key])
                        }
                        if scenario == .sidebarFork {
                            XCTAssertNil(profile)
                            XCTAssertEqual(params["parentSessionKey"] as? String, session.sessionKey)
                            XCTAssertEqual(params["agentId"] as? String, session.agentID)
                            XCTAssertEqual(params["fork"] as? Bool, true)
                            return .success(["key": "agent:main:forked-visual"])
                        }
                        if scenario.testsSidebarNewChat {
                            XCTAssertEqual(profile, scenario == .sidebarNewChatOrdinary ? nil : session.owner.profileID)
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
            let retainApprovalFixture = {
                restoreBridgeState = false
                Self.retainedApprovalFixtures.append((
                    model: model, gatewayID: gatewayID, deviceID: approvalDeviceID, bridgeState: previousBridgeState))
            }
            let cleanup: () async -> Void = {
                approvalRelease.continuation.finish()
                await approvalEventTask?.value
                // The event is joined; its scheduled refresh has no public join handle.
                // Its predicate is retired, and the terminal owner makes pre-guard pruning inert.
                approvalEvent.isCurrent = false
                var modalCleanupSucceeded = true
                if let approvalTerminalJSON {
                    var terminalApplied = false
                    do {
                        terminalApplied = try await model._test_applyUnifiedExecApprovalResolveResult(
                            approvalTerminalJSON, approvalID: approvalID, attemptedDecision: .deny)
                    } catch {
                        XCTFail("Fixture approval terminal cleanup failed: \(error)")
                    }
                    model.dismissPendingExecApprovalPrompt()
                    model.dismissNotificationPermissionGuidancePrompt(suppressFuture: false)
                    modalCleanupSucceeded = terminalApplied &&
                        model.pendingExecApprovalPrompt == nil &&
                        model.pendingNotificationPermissionGuidancePrompt == nil &&
                        model.pendingExecApprovalInboxItems.isEmpty &&
                        model._test_watchExecApprovalCacheIDs().isEmpty &&
                        model._test_pendingPersistedExecApprovalReadbacks().isEmpty
                }
                if scenario == .agentDeepLink {
                    if model.pendingAgentDeepLinkPrompt?.id == ownedDeepLinkPromptID {
                        model.declinePendingAgentDeepLinkPrompt()
                    }
                    model.gatewayConnected = originalNodeConnected
                }
                if scenario == .gatewayTrust {
                    controller.declinePendingTrustPrompt(ownedTrustPrompt)
                    do {
                        try await self.waitUntil { !controller.hasPendingConnectionHandoff }
                    } catch {
                        modalCleanupSucceeded = false
                        XCTFail("Fixture trust cancellation did not settle")
                    }
                    XCTAssertNil(GatewayTLSStore.loadFingerprint(stableID: trustGatewayID))
                }
                historyRelease.continuation.finish()
                createRelease.continuation.finish()
                adoptionRelease.continuation.finish()
                await forking?.value
                _ = await creating?.value
                opening?.cancel()
                _ = await opening?.value
                preparingModal?.cancel()
                _ = try? await preparingModal?.value
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
                if scenario.testsSidebarNewChat {
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
                if hasApprovalFixture {
                    restoreBridgeState = modalCleanupSucceeded
                    if !modalCleanupSucceeded { retainApprovalFixture() }
                }
                guard modalCleanupSucceeded else {
                    XCTFail("Native modal cleanup incomplete; retaining fixture state, credentials and cache")
                    return
                }
                if let approvalDeviceID {
                    let stored = DeviceAuthStore.loadToken(
                        deviceId: approvalDeviceID, role: "operator", gatewayID: gatewayID)
                    guard stored == nil || stored?.token == approvalToken else {
                        retainApprovalFixture()
                        XCTFail("Fixture operator credential changed; retaining the replacement")
                        return
                    }
                    if stored != nil {
                        DeviceAuthStore.clearToken(
                            deviceId: approvalDeviceID, role: "operator", gatewayID: gatewayID)
                    }
                    guard DeviceAuthStore.loadToken(
                        deviceId: approvalDeviceID, role: "operator", gatewayID: gatewayID) == nil
                    else {
                        retainApprovalFixture()
                        XCTFail("Fixture operator credential did not clear; retaining fixture state")
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
                if hasApprovalFixture {
                    let responses = try self.approvalResponses(id: approvalID, session: session)
                    approvalTerminalJSON = responses.resolve
                    restoreBridgeState = false
                    model._test_setUnifiedExecApprovalGetResponses(
                        [(
                            approvalID: approvalID,
                            json: scenario == .approvalDashboard ? responses.pending : responses.terminal)],
                        beforeResponse: { _ in
                            guard scenario == .notificationGuidance else { return }
                            await MainActor.run { approvalEvent.getEntered = true }
                            for await _ in approvalRelease.stream {
                                break
                            }
                        },
                        listResponses: [
                            "exec.approval.list": "[]", "plugin.approval.list": "[]",
                            "openclaw.approval.list": scenario == .approvalDashboard ? responses.list : "[]",
                        ])
                }
                let root = RootTabs(initialSidebarVisibility: false)
                    .environment(AppAppearanceModel())
                    .environment(model)
                    .environment(model.voiceWake)
                    .environment(controller)
                    .environment(router)
                    .environment(\.scenePhase, .active)
                    .preferredColorScheme(.light)
                let hosting = UIHostingController(rootView: AnyView(root))
                let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                    .filter { $0.activationState == .foregroundActive }
                XCTAssertEqual(scenes.count, 1)
                guard scenes.count == 1 else { throw OpenClawNativeActionError("Native visual scene is ambiguous") }
                let scene = try XCTUnwrap(scenes.first)
                previousKeyWindow = scene.windows.first { $0.isKeyWindow && !$0.isHidden }
                let ownedWindow = UIWindow(windowScene: scene)
                if scenario == .pagesPrepared || scenario == .pagesRemoval {
                    ownedWindow.frame = CGRect(x: 0, y: 0, width: 1024, height: 768)
                } else {
                    ownedWindow.frame = scenario == .chatModalNewOptionsCover || scenario == .pagesAdmissionCover
                        ? CGRect(x: 0, y: 0, width: 852, height: 393)
                        : CGRect(x: 0, y: 0, width: 393, height: 852)
                }
                if scenario == .chatModalNewOptionsCover || scenario == .pagesAdmissionCover ||
                    scenario == .pagesRemoval
                {
                    hosting.traitOverrides.verticalSizeClass = .compact
                }
                window = ownedWindow
                ownedWindow.rootViewController = hosting
                ownedWindow.makeKeyAndVisible()
                hosting.view.layoutIfNeeded()
                // Open waits for RootTabs' real onAppear registration, after its initial
                // session adoption. No test presentation handler or demo mode is used.
                XCTAssertEqual(UIApplication.shared.applicationState, .active)
                if scenario == .sidebarNewChatOrdinary {
                    try await self.waitUntil { router.presentationRegistrationID != nil }
                    model.setSelectedAgentId(session.agentID)
                    model.focusChatSession(session.sessionKey)
                    try await self.selectSidebarDestination("chat", in: ownedWindow)
                    try await self.waitUntil { model.chatPresentation.viewModel != nil }
                    XCTAssertNil(model.chatPresentation.transport?.nativeBinding)
                } else {
                    let opened = await router.open(.session(session))
                    XCTAssertEqual(opened, .opened)
                    guard opened == .opened else { throw OpenClawNativeActionError("Visual chat did not open") }
                }
                XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                try await self.waitForComposer(in: ownedWindow)
                XCTAssertNil(hosting.presentedViewController)

                if scenario.testsPagesEditor {
                    // Keep Edit Pages reachable before capturing native authority; no
                    // additional navigation should explain the later refusal.
                    try await self.showSidebar(in: ownedWindow)
                    try await self.waitUntil {
                        guard let chat = model.chatPresentation.viewModel else { return false }
                        return chat.hasCurrentSessionMetadata && !chat.isLoading && chat.healthOK &&
                            chat.canPreserveIdleTextDraft && chat.input.isEmpty
                    }
                    let rootRegistration = try XCTUnwrap(router.presentationRegistrationID)
                    let route = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    let prepared: OpenClawNativePreparedSend?
                    if scenario == .pagesPrepared || scenario == .pagesRemoval {
                        prepared = try await router.prepareSend(to: session, message: "fresh after Pages").send
                        // Split layout keeps Edit Pages reachable without another
                        // navigation action retiring the confirmation before the sheet.
                        XCTAssertEqual(RootTabs.sidebarLayoutMode(containerSize: ownedWindow.bounds.size), .split)
                        XCTAssertNotNil(try self.accessibilityElement(
                            nil, label: "Edit Pages", in: ownedWindow, button: true))
                    } else {
                        prepared = nil
                    }
                    let heldPrepare = scenario == .pagesHeldPrepare
                    let heldInspect = scenario == .pagesHeldInspect
                    let heldOpen = scenario == .pagesHeldOpen
                    if heldPrepare || heldInspect || heldOpen {
                        holdNativeHistory = true
                        holdAnyNativeHistory = !heldInspect
                        if heldPrepare {
                            preparingModal = Task {
                                try await router.prepareSend(to: session, message: "held Pages preparation").send
                            }
                        } else {
                            opening = Task { await router.open(heldInspect ? .inspect(run) : .session(session)) }
                        }
                        try await self.waitUntil { historyEntered }
                        let held = try XCTUnwrap(heldPagesHistory)
                        XCTAssertEqual(held.key, session.sessionKey)
                        XCTAssertEqual(held.agent, session.agentID)
                        XCTAssertEqual(held.profile, session.owner.profileID)
                        XCTAssertEqual(held.runIDs, heldInspect ? [run.runID] : nil)
                    }
                    try await self.activateLabel("Edit Pages", in: ownedWindow)
                    try await self.waitForNavigationTitle("Pages", in: ownedWindow)
                    let sheet = try XCTUnwrap(hosting.presentedViewController)
                    if scenario == .pagesAdmissionCover || scenario == .pagesRemoval {
                        try await self.waitUntil { hosting.view.window == nil }
                    }
                    // Pages uses ordinary departure. A cover can postpone idle VM
                    // replacement; assert the live editor, not a required transport kind.
                    try await self.waitUntil {
                        guard let chat = model.chatPresentation.viewModel else { return false }
                        return chat.hasCurrentSessionMetadata && !chat.isLoading && chat.healthOK &&
                            chat.canPreserveIdleTextDraft
                    }
                    let chat = try XCTUnwrap(model.chatPresentation.viewModel)
                    let target = chat.currentSessionTarget
                    let owner = model.chatPresentation.ownerID
                    let generation = model.operatorAuthorityGeneration
                    let config = model.activeGatewayConnectConfig?.controlUIInputs
                    let reply = chat.replyTarget
                    let attachments = chat.attachments.map(\.id)
                    XCTAssertEqual(router.presentationRegistrationID, rootRegistration)
                    XCTAssertNotNil(router.capturePresentationAuthority(rootRegistration))
                    XCTAssertTrue(chat.input.isEmpty)
                    XCTAssertTrue(attachments.isEmpty)
                    XCTAssertNil(reply)
                    @MainActor
                    func assertPagesState() {
                        let current = model.chatPresentation.viewModel
                        XCTAssertNotNil(current)
                        XCTAssertEqual(model.chatPresentation.ownerID, owner)
                        XCTAssertEqual(current?.currentSessionTarget, target)
                        XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                        XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                        XCTAssertEqual(current?.input, "")
                        XCTAssertEqual(current?.replyTarget, reply)
                        XCTAssertEqual(current?.attachments.map(\.id), attachments)
                        XCTAssertEqual(model.operatorAuthorityGeneration, generation)
                        XCTAssertEqual(model.activeGatewayConnectConfig?.controlUIInputs, config)
                        XCTAssertTrue(hosting.presentedViewController === sheet)
                        XCTAssertEqual(router.presentationRegistrationID, rootRegistration)
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)
                    }
                    if scenario == .pagesAdmission || scenario == .pagesAdmissionCover {
                        let research = OpenClawNativeSessionRef(
                            owner: session.owner, agentID: "research", sessionKey: session.sessionKey)
                        for destination in [session, research] {
                            for request in [
                                OpenClawNativeOpenRequest.session(destination),
                                .compose(destination, draft: "Incoming Pages draft"),
                                .inspect(.init(session: destination, runID: run.runID)),
                            ] {
                                let result = await router.open(request)
                                XCTAssertEqual(result, .unavailable(
                                    reason: "Finish the current screen in OpenClaw, then try again."))
                                assertPagesState()
                            }
                            do {
                                _ = try await router.prepareSend(to: destination, message: "Refused behind Pages").send
                                XCTFail("Pages admitted a native confirmation")
                            } catch {
                                XCTAssertEqual(
                                    error.localizedDescription,
                                    "Finish the current screen in OpenClaw, then try again.")
                            }
                            assertPagesState()
                        }
                    }
                    if scenario == .pagesRemoval {
                        let oldConfirmation = try XCTUnwrap(prepared)
                        hosting.rootView = AnyView(Color.clear)
                        try await self.waitUntil {
                            router.presentationRegistrationID == nil && router.chatRegistrationID == nil &&
                                hosting.presentedViewController == nil
                        }
                        XCTAssertNil(router.presentationRegistrationID)
                        for _ in 0..<2 {
                            do {
                                _ = try await oldConfirmation.submit()
                                XCTFail("Removed Pages Root retained native confirmation authority")
                            } catch {
                                XCTAssertEqual(
                                    error.localizedDescription,
                                    "The action route changed. Select the session again.")
                            }
                        }
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)
                        let remainingRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        XCTAssertEqual(remainingRoute, route)
                        await cleanup()
                        return
                    }
                    if scenario == .pagesAdmission {
                        let pinID = "RootTabs.Sidebar.Pages.Pin.overview"
                        let unpin = try XCTUnwrap(self.accessibilityElement(pinID, in: ownedWindow, button: true))
                        XCTAssertTrue(unpin.accessibilityActivate())
                        try await self.waitUntil {
                            UserDefaults.standard.string(forKey: "sidebar.pinnedPages") == "usage"
                        }
                        let pin = try XCTUnwrap(self.accessibilityElement(pinID, in: ownedWindow, button: true))
                        XCTAssertTrue(pin.accessibilityActivate())
                        try await self.waitUntil {
                            UserDefaults.standard.string(forKey: "sidebar.pinnedPages") == "usage,overview"
                        }
                    }
                    try await self.activateLabel("Done", in: ownedWindow)
                    try await self.waitUntil {
                        hosting.presentedViewController == nil &&
                            router.presentationRegistrationID == rootRegistration
                    }
                    if heldPrepare {
                        historyRelease.continuation.finish()
                        do {
                            _ = try await preparingModal?.value
                            XCTFail("Pages open-close revived held preparation")
                        } catch is CancellationError {
                        } catch {
                            XCTFail("Unexpected held Pages preparation result: \(error)")
                        }
                    } else if heldOpen || heldInspect {
                        historyRelease.continuation.finish()
                        let result = await opening?.value
                        XCTAssertEqual(result, .cancelled)
                    }
                    XCTAssertNil(hosting.presentedViewController)
                    XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                    XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                    XCTAssertEqual(model.chatPresentation.viewModel?.input, "")
                    XCTAssertEqual(sends, 0)
                    XCTAssertEqual(creates, 0)
                    if scenario == .pagesAdmission {
                        // Exercise real interactive dismissal as well as Done, then
                        // both pinned navigation and the editor's guarded select row.
                        try await self.activateLabel("Edit Pages", in: ownedWindow)
                        try await self.waitForNavigationTitle("Pages", in: ownedWindow)
                        let reopened = try XCTUnwrap(hosting.presentedViewController)
                        guard reopened.view.accessibilityPerformEscape() else {
                            throw OpenClawNativeActionError("Pages interactive dismissal did not activate")
                        }
                        try await self.waitUntil { hosting.presentedViewController == nil }
                        try await self.selectSidebarDestination("overview", in: ownedWindow)
                        try await self.waitForNavigationTitle("Overview", in: ownedWindow)
                        XCTAssertEqual(UserDefaults.standard.string(forKey: "sidebar.pinnedPages"), "usage,overview")
                        try await self.showSidebar(in: ownedWindow)
                        try await self.activateLabel("Edit Pages", in: ownedWindow)
                        try await self.waitForNavigationTitle("Pages", in: ownedWindow)
                        let select = try XCTUnwrap(self.accessibilityElement(
                            "RootTabs.Sidebar.Pages.Select.overview", in: ownedWindow, button: true))
                        guard select.accessibilityActivate() else {
                            throw OpenClawNativeActionError("Pages destination row did not activate")
                        }
                        try await self.waitUntil { hosting.presentedViewController == nil }
                        try await self.waitForNavigationTitle("Overview", in: ownedWindow)
                        XCTAssertEqual(UserDefaults.standard.string(forKey: "sidebar.pinnedPages"), "usage,overview")
                    }
                    if let prepared {
                        for _ in 0..<2 {
                            do {
                                _ = try await prepared.submit()
                                XCTFail("Pages open-close revived an old confirmation")
                            } catch {
                                XCTAssertEqual(
                                    error.localizedDescription,
                                    "The action route changed. Select the session again.")
                            }
                        }
                        XCTAssertEqual(sends, 0)
                        permitsModalSend = true
                        let fresh = try await router.prepareSend(to: session, message: "fresh after Pages").send
                        let receipt = try await fresh.submit()
                        XCTAssertEqual(receipt.session, session)
                        XCTAssertEqual(sends, 1)
                        let replayed = try await fresh.submit()
                        XCTAssertEqual(replayed, receipt)
                        XCTAssertEqual(sends, 1)
                    } else {
                        let fresh = await router.open(.compose(session, draft: "Fresh after Pages"))
                        XCTAssertEqual(fresh, .opened)
                        XCTAssertEqual(model.chatPresentation.viewModel?.input, "Fresh after Pages")
                        try await self.waitForComposer(in: ownedWindow, expectedText: "Fresh after Pages")
                        XCTAssertEqual(sends, 0)
                    }
                    XCTAssertEqual(router.presentationRegistrationID, rootRegistration)
                    XCTAssertNil(hosting.presentedViewController)
                    XCTAssertEqual(creates, 0)
                    let finalRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    XCTAssertEqual(finalRoute, route)
                    await cleanup()
                    try await self.waitUntil {
                        router.presentationRegistrationID == nil && router.chatRegistrationID == nil
                    }
                    return
                }
                if scenario.testsChatModal {
                    let chat = try XCTUnwrap(model.chatPresentation.viewModel)
                    try await self.waitUntil {
                        chat.hasCurrentSessionMetadata && !chat.isLoading && chat.healthOK &&
                            chat.messages.contains { $0.role == "assistant" }
                    }
                    let target = chat.currentSessionTarget
                    let route = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    let generation = model.operatorAuthorityGeneration
                    let protectedReply = chat.replyTarget
                    let protectedAttachments = chat.attachments.map(\.id)
                    XCTAssertTrue(chat.input.isEmpty)
                    XCTAssertTrue(protectedAttachments.isEmpty)
                    XCTAssertNil(protectedReply)
                    let prepared: OpenClawNativePreparedSend? = if scenario == .chatModalPreparedApp || scenario ==
                        .chatModalPreparedShared ||
                        scenario == .chatModalRemovalApp || scenario == .chatModalRemovalShared
                    {
                        try await router.prepareSend(to: session, message: "fresh after dismissal").send
                    } else {
                        nil
                    }
                    // Preparation may publish an equivalent binding and register its exact
                    // visible projection. Freeze cover custody only after that operation.
                    let binding = try XCTUnwrap(model.chatPresentation.transport?.nativeBinding)
                    let registration = try XCTUnwrap(router.chatRegistrationID)
                    let rootRegistration = try XCTUnwrap(router.presentationRegistrationID)
                    let heldPrepare = scenario == .chatModalHeldPrepareApp || scenario == .chatModalHeldPrepareShared
                    let heldInspect = scenario == .chatModalHeldInspectApp || scenario == .chatModalHeldInspectShared
                    let heldOpen = scenario == .chatModalHeldOpenApp || scenario == .chatModalHeldOpenShared
                    if heldPrepare || heldInspect || heldOpen {
                        holdNativeHistory = true
                        holdAnyNativeHistory = !heldInspect
                        if heldPrepare {
                            preparingModal = Task {
                                try await router.prepareSend(to: session, message: "held modal preparation").send
                            }
                        } else {
                            opening = Task { await router.open(heldInspect ? .inspect(run) : .session(session)) }
                        }
                        try await self.waitUntil { historyEntered }
                        XCTAssertTrue(modalHistoryReads.contains {
                            $0.key == session.sessionKey && $0.agent == session.agentID &&
                                $0.profile == session.owner.profileID
                        })
                    }

                    if scenario.usesSharedChatModal {
                        try await self.activateLabel("Message Actions", in: ownedWindow)
                        try await self.activateLabel("Select Text", in: ownedWindow)
                    } else {
                        try await self.activateLabel("Chat actions", in: ownedWindow)
                        try await self.activateLabel(
                            scenario == .chatModalNewOptionsCover ? "New session options…" : "Background tasks",
                            in: ownedWindow)
                    }
                    let title = scenario.usesSharedChatModal ? "Select Text" :
                        (scenario == .chatModalNewOptionsCover ? "New Thread" : "Background Tasks")
                    try await self.waitUntil {
                        try hosting.presentedViewController != nil &&
                            (self.accessibilityElement(nil, label: title, in: ownedWindow)) != nil
                    }
                    let sheet = try XCTUnwrap(hosting.presentedViewController)
                    if scenario.usesSharedChatModal {
                        XCTAssertNotNil(try self.accessibilityElement(
                            "chat-selectable-text", in: ownedWindow))
                    }
                    if scenario == .chatModalNewOptionsCover {
                        // Compact height uses the actual full-screen adaptation. The UI
                        // transition owner survives cover; native permits do not.
                        try await self.waitUntil { hosting.view.window == nil }
                    }
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(router.chatRegistrationID, registration)
                    XCTAssertEqual(router.presentationRegistrationID, rootRegistration)
                    XCTAssertTrue(model.chatPresentation.transport?.nativeBinding?.canReuse(binding) == true)
                    XCTAssertEqual(chat.currentSessionTarget, target)

                    if scenario == .chatModalRemovalApp || scenario == .chatModalRemovalShared {
                        let oldConfirmation = try XCTUnwrap(prepared)
                        // Remove the actual SwiftUI owner while its modal is still active.
                        // This must dismantle the exact anchors, not treat removal as cover.
                        hosting.rootView = AnyView(Color.clear)
                        try await self.waitUntil {
                            router.presentationRegistrationID == nil && router.chatRegistrationID == nil &&
                                hosting.presentedViewController == nil
                        }
                        XCTAssertNil(router.presentationRegistrationID)
                        do {
                            _ = try await oldConfirmation.submit()
                            XCTFail("Removed Root retained native confirmation authority")
                        } catch {
                            XCTAssertEqual(
                                error.localizedDescription,
                                "The action route changed. Select the session again.")
                        }
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)
                        let remainingRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        XCTAssertEqual(remainingRoute, route)
                        await cleanup()
                        return
                    }

                    if scenario == .chatModalAdmissionApp || scenario == .chatModalAdmissionShared {
                        let research = OpenClawNativeSessionRef(
                            owner: session.owner, agentID: "research", sessionKey: session.sessionKey)
                        for destination in [session, research] {
                            for request in [
                                OpenClawNativeOpenRequest.session(destination),
                                .compose(destination, draft: "Incoming native draft"),
                                .inspect(.init(session: destination, runID: run.runID)),
                            ] {
                                let result = await router.open(request)
                                XCTAssertEqual(result, .unavailable(
                                    reason: "Finish the current screen in OpenClaw, then try again."))
                                XCTAssertTrue(model.chatPresentation.viewModel === chat)
                                XCTAssertEqual(chat.currentSessionTarget, target)
                                XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                                XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                                XCTAssertEqual(chat.input, "")
                                XCTAssertEqual(chat.replyTarget, protectedReply)
                                XCTAssertEqual(chat.attachments.map(\.id), protectedAttachments)
                                XCTAssertTrue(hosting.presentedViewController === sheet)
                                XCTAssertEqual(model.operatorAuthorityGeneration, generation)
                                XCTAssertTrue(model.chatPresentation.transport?.nativeBinding?
                                    .canReuse(binding) == true)
                                XCTAssertEqual(sends, 0)
                                XCTAssertEqual(creates, 0)
                            }
                        }
                    }

                    if scenario == .chatModalNewOptionsCover {
                        try await self.activateLabel("Create Thread", in: ownedWindow)
                        try await self.waitUntil {
                            guard creates == 1, !chat.isCreatingSession,
                                  let error = chat.errorText, !error.isEmpty else { return false }
                            return try self.accessibilityElement(nil, label: error, in: ownedWindow) != nil
                        }
                        XCTAssertTrue(hosting.presentedViewController === sheet)
                        XCTAssertTrue(model.chatPresentation.viewModel === chat)
                        XCTAssertEqual(router.chatRegistrationID, registration)
                        try await self.activateLabel("Create Thread", in: ownedWindow)
                        try await self.waitUntil {
                            creates == 2 && !chat.isCreatingSession && chat.hasCurrentSessionMetadata &&
                                !chat.isLoading && hosting.presentedViewController == nil
                        }
                        let child = try XCTUnwrap(createdKeys.last)
                        XCTAssertTrue(model.chatPresentation.viewModel === chat)
                        XCTAssertEqual(model.chatSessionKey, child)
                        XCTAssertEqual(chat.currentSessionTarget.sessionKey, child)
                        XCTAssertEqual(model.chatPresentation.transport?.nativeBinding?.session.sessionKey, child)
                        XCTAssertEqual(sends, 0)
                    } else {
                        if scenario.usesSharedChatModal {
                            try await self.activateLabel("Close", in: ownedWindow)
                        } else {
                            XCTAssertTrue(sheet.view.accessibilityPerformEscape())
                        }
                        try await self.waitUntil { hosting.presentedViewController == nil }
                        XCTAssertTrue(model.chatPresentation.viewModel === chat)
                        XCTAssertEqual(router.chatRegistrationID, registration)
                        if heldPrepare {
                            historyRelease.continuation.finish()
                            do {
                                _ = try await preparingModal?.value
                                XCTFail("A modal open-close revived held preparation")
                            } catch is CancellationError {
                            } catch {
                                XCTFail("Unexpected held preparation result: \(error)")
                            }
                        } else if heldOpen || heldInspect {
                            historyRelease.continuation.finish()
                            let heldResult = await opening?.value
                            XCTAssertEqual(heldResult, .cancelled)
                        }
                        if let prepared {
                            for _ in 0..<2 {
                                do {
                                    _ = try await prepared.submit()
                                    XCTFail("A modal open-close revived an old confirmation")
                                } catch {
                                    XCTAssertEqual(
                                        error.localizedDescription,
                                        "The action route changed. Select the session again.")
                                }
                            }
                            XCTAssertEqual(sends, 0)
                            permitsModalSend = true
                            let fresh = try await router.prepareSend(to: session, message: "fresh after dismissal").send
                            let receipt = try await fresh.submit()
                            XCTAssertEqual(receipt.session, session)
                            XCTAssertEqual(sends, 1)
                            let replayed = try await fresh.submit()
                            XCTAssertEqual(replayed, receipt)
                            XCTAssertEqual(sends, 1)
                        } else {
                            let freshOpen = await router.open(.compose(session, draft: "Fresh visible draft"))
                            XCTAssertEqual(freshOpen, .opened)
                            XCTAssertEqual(model.chatPresentation.viewModel?.input, "Fresh visible draft")
                            try await self.waitForComposer(in: ownedWindow, expectedText: "Fresh visible draft")
                            XCTAssertEqual(sends, 0)
                        }
                        XCTAssertNil(hosting.presentedViewController)
                    }
                    let finalRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    XCTAssertEqual(finalRoute, route)
                    await cleanup()
                    try await self.waitUntil { router.chatRegistrationID == nil }
                    XCTAssertNil(router.chatRegistrationID)
                    return
                }
                if scenario == .nativeOpenAccountABA || scenario == .nativeInspectAccountABA ||
                    scenario == .nativePreparedSendAccountABA
                {
                    let chat = try XCTUnwrap(model.chatPresentation.viewModel)
                    let target = chat.currentSessionTarget
                    let original = try XCTUnwrap(model.activeGatewayConnectConfig)
                    let generation = model.operatorAuthorityGeneration
                    let route = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    let prepared: OpenClawNativePreparedSend?
                    if scenario == .nativePreparedSendAccountABA {
                        prepared = try await router.prepareSend(to: session, message: "retired account confirmation")
                            .send
                        XCTAssertTrue(chat.hasCurrentSessionMetadata)
                        XCTAssertTrue(chat.healthOK)
                        XCTAssertFalse(chat.hasBlockingRunActivity)
                        XCTAssertFalse(chat.isSending)
                    } else {
                        prepared = nil
                        holdNativeHistory = true
                        holdAnyNativeHistory = scenario == .nativeOpenAccountABA
                        opening = Task {
                            await router.open(
                                scenario == .nativeOpenAccountABA ? .session(session) : .inspect(run))
                        }
                        try await self.waitUntil { historyEntered }
                    }
                    model.activeGatewayConnectConfig = GatewayConnectConfig(
                        url: original.url, stableID: original.stableID, tls: original.tls,
                        token: "synthetic-admission-replacement", bootstrapToken: original.bootstrapToken,
                        password: original.password, nodeOptions: original.nodeOptions)
                    model.activeGatewayConnectConfig = original
                    XCTAssertNotEqual(model.operatorAuthorityGeneration, generation)
                    XCTAssertEqual(model.activeGatewayConnectConfig?.controlUIInputs, original.controlUIInputs)
                    let routeAfterABA = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    XCTAssertEqual(routeAfterABA, route)
                    if let prepared {
                        do {
                            _ = try await prepared.submit()
                            XCTFail("A prepared send survived an account lifetime change")
                        } catch {
                            XCTAssertEqual(
                                error.localizedDescription,
                                "The action route changed. Select the session again.")
                        }
                    } else {
                        historyRelease.continuation.finish()
                        let outcome = await opening?.value
                        XCTAssertEqual(outcome, .cancelled)
                    }
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(chat.currentSessionTarget, target)
                    XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                    XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                    XCTAssertNil(hosting.presentedViewController)
                    XCTAssertEqual(sends, 0)
                    XCTAssertEqual(creates, 0)
                    await cleanup()
                    return
                }
                if scenario.testsNativeAdoption {
                    let chat = try XCTUnwrap(model.chatPresentation.viewModel)
                    let parentBinding = try XCTUnwrap(model.chatPresentation.transport?.nativeBinding)
                    let parentTarget = chat.currentSessionTarget
                    let originalConfig = try XCTUnwrap(model.activeGatewayConnectConfig)
                    let originalRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    let originalGeneration = model.operatorAuthorityGeneration
                    let prepared = try await router.prepareSend(to: session, message: "old parent confirmation").send
                    let parentAuthority = chat.captureSessionTransitionAuthority()
                    chat.input = "parent draft"
                    let message = OpenClawChatMessage(
                        role: "user", content: [], timestamp: nil, transcriptMessageID: "visual-user-message")
                    if scenario == .nativeCreateAccountABA {
                        creating = Task { await chat.startNewSession() }
                    } else {
                        forking = Task { await chat.forkAtMessage(message) }
                    }
                    if scenario.holdsNativeAdoption {
                        try await self.waitUntil { adoptionEntered }
                        if scenario == .nativeForkNavigation {
                            try await self.selectSidebarDestination("settings", in: ownedWindow)
                            try await self.waitForNavigationTitle("Settings", in: ownedWindow)
                        } else if scenario == .nativeForkRoute {
                            await model.operatorSession.disconnect()
                        } else {
                            // Change away and back without yielding: equality alone would miss
                            // this account lifetime change while the original RPC is held.
                            model.activeGatewayConnectConfig = GatewayConnectConfig(
                                url: originalConfig.url, stableID: originalConfig.stableID, tls: originalConfig.tls,
                                token: "synthetic-adoption-replacement", bootstrapToken: originalConfig.bootstrapToken,
                                password: originalConfig.password, nodeOptions: originalConfig.nodeOptions)
                            model.activeGatewayConnectConfig = originalConfig
                            XCTAssertNotEqual(model.operatorAuthorityGeneration, originalGeneration)
                            XCTAssertEqual(
                                model.activeGatewayConnectConfig?.controlUIInputs,
                                originalConfig.controlUIInputs)
                            let routeAfterABA = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                            XCTAssertEqual(routeAfterABA, originalRoute)
                        }
                        if scenario == .nativeForkRoute {
                            let disconnectedRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                            XCTAssertNil(disconnectedRoute)
                        } else {
                            XCTAssertFalse(parentAuthority())
                        }
                        adoptionRelease.continuation.finish()
                        await forking?.value
                        if let creating {
                            let adopted = await creating.value
                            XCTAssertFalse(adopted)
                        }
                        XCTAssertTrue(model.chatPresentation.viewModel === chat)
                        XCTAssertEqual(chat.currentSessionTarget, parentTarget)
                        XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                        XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                        XCTAssertEqual(chat.input, "parent draft")
                        XCTAssertTrue(chat.attachments.isEmpty)
                        XCTAssertFalse(historyTargets.contains("\(session.agentID)|\(firstForkKey)"))
                        XCTAssertEqual(sends, 0)
                        await cleanup()
                        return
                    }
                    await forking?.value
                    try await self.waitUntil { !chat.isLoading }
                    let child = OpenClawNativeSessionRef(
                        owner: session.owner, agentID: session.agentID, sessionKey: firstForkKey)
                    let childBinding = try XCTUnwrap(model.chatPresentation.transport?.nativeBinding)
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(childBinding.session, child)
                    XCTAssertEqual(childBinding.route, parentBinding.route)
                    XCTAssertEqual(childBinding.profileObservationID, parentBinding.profileObservationID)
                    XCTAssertEqual(model.chatSessionKey, firstForkKey)
                    XCTAssertEqual(chat.currentSessionTarget.sessionKey, firstForkKey)
                    XCTAssertEqual(chat.selectedAgentID, session.agentID)
                    XCTAssertEqual(chat.input, "restored fork draft")
                    let attachmentIDs = chat.attachments.map(\.id)
                    let attachmentMIMETypes = chat.attachments.map(\.mimeType)
                    let attachmentData = chat.attachments.map(\.data)
                    XCTAssertEqual(attachmentMIMETypes, ["image/webp"])
                    XCTAssertEqual(attachmentData, [forkImage])
                    XCTAssertTrue(historyTargets.contains("\(session.agentID)|\(firstForkKey)"))
                    XCTAssertFalse(parentAuthority())
                    XCTAssertTrue(chat.captureSessionTransitionAuthority()())
                    do {
                        _ = try await prepared.submit()
                        XCTFail("A parent confirmation survived fork adoption")
                    } catch {
                        XCTAssertEqual(
                            error.localizedDescription,
                            "The action route changed. Select the session again.")
                    }
                    XCTAssertEqual(sends, 0)
                    let reopenedChild = await router.open(.session(child))
                    XCTAssertEqual(reopenedChild, .opened)
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(chat.input, "restored fork draft")
                    XCTAssertEqual(chat.attachments.map(\.id), attachmentIDs)
                    XCTAssertEqual(chat.attachments.map(\.mimeType), attachmentMIMETypes)
                    XCTAssertEqual(chat.attachments.map(\.data), attachmentData)

                    // Once the user removes the restored attachment, later session actions
                    // must use the adopted opaque target, not the parent's fallback scope.
                    for attachment in chat.attachments {
                        chat.removeAttachment(attachment.id)
                    }
                    await chat.forkAtMessage(message)
                    try await self.waitUntil { !chat.isLoading }
                    let secondKey = "opaque-visual-second-fork"
                    XCTAssertEqual(chat.sessionKey, secondKey)
                    XCTAssertEqual(forkTargets.map(\.sessionKey), [session.sessionKey, firstForkKey])
                    XCTAssertEqual(forkTargets.map(\.agentID), [session.agentID, session.agentID])
                    XCTAssertEqual(chat.attachments.map(\.data), [forkImage])
                    for attachment in chat.attachments {
                        chat.removeAttachment(attachment.id)
                    }
                    await chat.performReset(presentationIsCurrent: chat.captureSessionTransitionAuthority())
                    try await self.waitUntil { !chat.isLoading }
                    XCTAssertEqual(resetTargets, [.init(sessionKey: secondKey, agentID: session.agentID)])
                    let created = await chat.startNewSession()
                    XCTAssertTrue(created)
                    try await self.waitUntil { !chat.isLoading }
                    XCTAssertEqual(creates, 1)
                    XCTAssertEqual(chat.sessionKey, createdKeys.first)
                    XCTAssertEqual(model.chatSessionKey, createdKeys.first)
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertTrue(chat.input.isEmpty)
                    XCTAssertTrue(chat.switchSession(to: secondKey, agentID: session.agentID))
                    let returned = chat.currentSessionSnapshot()
                    try await self.waitUntil {
                        chat.isCurrentSession(returned) && !chat.isLoading && chat.hasCurrentSessionMetadata
                    }
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(chat.currentSessionTarget, .init(sessionKey: secondKey, agentID: session.agentID))
                    XCTAssertEqual(model.chatSessionKey, secondKey)
                    XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                    XCTAssertEqual(chat.input, "restored fork draft")
                    let finalBinding = try XCTUnwrap(model.chatPresentation.transport?.nativeBinding)
                    XCTAssertEqual(finalBinding.session.sessionKey, secondKey)
                    XCTAssertEqual(finalBinding.profileObservationID, parentBinding.profileObservationID)
                    let currentBeforeRetirement = await finalBinding.isCurrent()
                    XCTAssertTrue(currentBeforeRetirement)
                    parentBinding.observe(.rejected(expectedProfileID: session.owner.profileID))
                    let currentAfterRetirement = await finalBinding.isCurrent()
                    XCTAssertFalse(currentAfterRetirement)
                    let routeAfterRetirement = await finalBinding.gateway.currentRoute(
                        ifGatewayID: finalBinding.session.owner.gatewayID)
                    XCTAssertEqual(routeAfterRetirement, finalBinding.route)
                    XCTAssertFalse(chat.captureSessionTransitionAuthority()())
                    XCTAssertEqual(sends, 0)
                    await cleanup()
                    return
                }
                if scenario.testsSidebarNewChat {
                    let ordinary = scenario == .sidebarNewChatOrdinary
                    let prepared: OpenClawNativePreparedSend? = if ordinary {
                        nil
                    } else {
                        try await router.prepareSend(to: session, message: "retired before New Chat").send
                    }
                    let chat = try XCTUnwrap(model.chatPresentation.viewModel)
                    creatingChat = chat
                    try await self.waitUntil { !chat.isLoading && chat.healthOK && chat.canPreserveIdleTextDraft }
                    let transport = try XCTUnwrap(model.chatPresentation.transport)
                    let parentBinding = transport.nativeBinding
                    XCTAssertEqual(parentBinding?.session, ordinary ? nil : session)
                    let parentTarget = chat.currentSessionTarget
                    let route = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    let oldAuthority = chat.captureSessionTransitionAuthority()
                    XCTAssertTrue(oldAuthority())
                    XCTAssertTrue(chat.input.isEmpty)
                    XCTAssertTrue(chat.attachments.isEmpty)
                    XCTAssertNil(chat.replyTarget)
                    if scenario == .sidebarNewChatProtected { chat.input = "retained Root New Chat draft" }
                    let previousRequest = model.newChatRequestID
                    try await self.showSidebar(in: ownedWindow)
                    try await self.activateLabel(String(localized: "New Chat"), in: ownedWindow)
                    let request = model.newChatRequestID
                    XCTAssertEqual(request, previousRequest + 1)
                    try await self.waitUntil { createEntered && chat.isCreatingSession }
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertTrue(model.chatPresentation.transport?.nativeBinding === parentBinding)
                    XCTAssertTrue(model.chatPresentation.transport?.gateway === transport.gateway)
                    XCTAssertEqual(chat.currentSessionTarget, parentTarget)
                    XCTAssertEqual(creates, 1)
                    XCTAssertFalse(model.consumeNewChatRequest(request))
                    XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                    if let prepared {
                        XCTAssertFalse(oldAuthority())
                        do {
                            _ = try await prepared.submit()
                            XCTFail("New Chat revived the old prepared confirmation")
                        } catch {
                            XCTAssertEqual(
                                error.localizedDescription,
                                "The action route changed. Select the session again.")
                        }
                    }
                    XCTAssertEqual(sends, 0)
                    let created = try XCTUnwrap(createdKeys.first)
                    XCTAssertNotEqual(created, session.sessionKey)
                    createRelease.continuation.finish()
                    // These are model completion/adoption observations. Root's SwiftUI
                    // task handle is not exposed, so this is not a join of that task.
                    try await self.waitUntil {
                        completedCreateReplies == creates && !chat.isCreatingSession &&
                            model.chatSessionKey == created &&
                            model.chatPresentation.viewModel?.currentSessionTarget.sessionKey == created &&
                            model.chatPresentation.viewModel?.isCreatingSession == false
                    }
                    try await self.waitForComposer(in: ownedWindow)
                    XCTAssertTrue(model.chatPresentation.viewModel === chat)
                    XCTAssertEqual(createdKeys, [created])
                    XCTAssertEqual(creates, 1)
                    XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                    XCTAssertEqual(
                        OpenClawChatSessionKey.agentID(from: chat.currentSessionTarget.sessionKey) ??
                            chat.currentSessionTarget.agentID,
                        session.agentID)
                    if let parentBinding {
                        let child = try XCTUnwrap(model.chatPresentation.transport?.nativeBinding)
                        XCTAssertEqual(child.session, .init(
                            owner: session.owner, agentID: session.agentID, sessionKey: created))
                        XCTAssertEqual(child.profileObservationID, parentBinding.profileObservationID)
                        XCTAssertEqual(child.route, parentBinding.route)
                        XCTAssertTrue(child.gateway === parentBinding.gateway)
                        XCTAssertTrue((chat.transport as? IOSGatewayChatTransport)?.nativeBinding?
                            .canReuse(child) == true)
                        let isCurrent = await child.isCurrent()
                        XCTAssertTrue(isCurrent)
                        XCTAssertFalse(oldAuthority())
                    } else {
                        XCTAssertNil(model.chatPresentation.transport?.nativeBinding)
                        XCTAssertNil((chat.transport as? IOSGatewayChatTransport)?.nativeBinding)
                    }
                    XCTAssertTrue(chat.captureSessionTransitionAuthority()())
                    let finalRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                    XCTAssertEqual(finalRoute, route)
                    XCTAssertNil(chat.errorText)
                    XCTAssertNil(model.chatPresentation.viewModel?.errorText)
                    XCTAssertEqual(sends, 0)
                    await cleanup()
                    return
                }
                if scenario == .inspectionDone || scenario == .inspectionEscape || scenario == .inspectionReplacement {
                    // The first real Run sheet has acknowledged appearance before the
                    // second same-run read begins, so opening cannot pre-cancel the read.
                    let inspected = try await router.inspect(run).inspection
                    XCTAssertEqual(inspected.run, run)
                    try await self.waitUntil {
                        guard hosting.presentedViewController?.view.window === ownedWindow else { return false }
                        return try self.accessibilityElement(
                            nil, label: "Done", in: ownedWindow, button: true) != nil
                    }
                    let sheet = try XCTUnwrap(hosting.presentedViewController)
                    let done = try XCTUnwrap(self.accessibilityElement(
                        nil, label: "Done", in: ownedWindow, button: true))
                    let binding = try XCTUnwrap(model.chatPresentation.transport?.nativeBinding)
                    holdNativeHistory = true
                    let task = Task { await router.open(.inspect(run)) }
                    opening = task
                    try await self.waitUntil { historyEntered }
                    guard hosting.presentedViewController === sheet, sheet.view.window === ownedWindow else {
                        throw OpenClawNativeActionError("Run sheet changed before the held inspection action")
                    }
                    XCTAssertEqual(inspectedRuns, [[run.runID], [run.runID]])
                    if scenario == .inspectionReplacement {
                        // A native receipt replacement is a projection, not a user departure.
                        historyRelease.continuation.finish()
                        let result = await task.value
                        XCTAssertEqual(result, .opened)
                        try await self.waitUntil { hosting.presentedViewController?.view.window === ownedWindow }
                    } else {
                        if scenario == .inspectionDone {
                            guard done.accessibilityActivate() else {
                                throw OpenClawNativeActionError("Run Done action did not activate")
                            }
                        } else {
                            guard sheet.view.accessibilityPerformEscape() else {
                                throw OpenClawNativeActionError("Run sheet did not accept accessibility dismissal")
                            }
                        }
                        try await self.waitUntil { hosting.presentedViewController == nil }
                        historyRelease.continuation.finish()
                        let result = await task.value
                        XCTAssertEqual(result, .cancelled)
                        XCTAssertNil(hosting.presentedViewController)
                        let routeIsCurrent = await binding.isCurrent()
                        XCTAssertTrue(routeIsCurrent)
                        try await self.waitForComposer(in: ownedWindow)
                        // A later explicit action may open a fresh, acknowledged receipt.
                        let reopened = try await router.inspect(run).inspection
                        XCTAssertEqual(reopened.run, run)
                        try await self.waitUntil { hosting.presentedViewController?.view.window === ownedWindow }
                        XCTAssertEqual(inspectedRuns, [[run.runID], [run.runID], [run.runID]])
                    }
                    XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                    XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                    XCTAssertEqual(sends, 0)
                    XCTAssertEqual(creates, 0)
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
                    if scenario == .gatewayDetails {
                        let config = try XCTUnwrap(model.activeGatewayConnectConfig)
                        let currentRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        let route = try XCTUnwrap(currentRoute)
                        let target = OpenClawChatSessionTarget(
                            sessionKey: model.chatSessionKey, agentID: model.chatDeliveryAgentId)
                        let selectedAgentID = model.selectedAgentId
                        // A retryable node error preserves the separate, ready operator route.
                        // Start the native action after Details opens, with fresh navigation authority.
                        let problem = try XCTUnwrap(model._test_applyNodeGatewayConnectionError(URLError(.timedOut)))
                        XCTAssertEqual(problem.kind, .timeout)
                        XCTAssertFalse(problem.pauseReconnect)
                        XCTAssertFalse(problem.needsPairingApproval)
                        XCTAssertTrue(model.isOperatorGatewayConnected)
                        XCTAssertEqual(model.activeGatewayConnectConfig?.controlUIInputs, config.controlUIInputs)
                        let afterErrorRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        XCTAssertEqual(afterErrorRoute, route)
                        try await self.waitUntil {
                            try self.accessibilityElement(
                                nil, label: String(localized: "Details"), in: ownedWindow, button: true) != nil
                        }
                        try await self.activateLabel(String(localized: "Details"), in: ownedWindow)
                        try await self.waitUntil { hosting.presentedViewController?.view.window === ownedWindow }
                        try await self.waitForNavigationTitle("Connection problem", in: ownedWindow)
                        let sheet = try XCTUnwrap(hosting.presentedViewController)
                        let requested = OpenClawNativeSessionRef(
                            owner: session.owner, agentID: "research", sessionKey: "global")
                        let result = await router.open(.session(requested))
                        XCTAssertEqual(
                            OpenClawChatSessionTarget(
                                sessionKey: model.chatSessionKey, agentID: model.chatDeliveryAgentId),
                            target,
                            "Native open changed selection behind Gateway details")
                        XCTAssertEqual(model.selectedAgentId, selectedAgentID)
                        XCTAssertEqual(result, .unavailable(
                            reason: "Finish the current screen in OpenClaw, then try again."))
                        XCTAssertTrue(hosting.presentedViewController === sheet)
                        XCTAssertTrue(sheet.view.window === ownedWindow)
                        try await self.waitForNavigationTitle("Connection problem", in: ownedWindow)
                        XCTAssertTrue(model.isOperatorGatewayConnected)
                        XCTAssertEqual(model.activeGatewayConnectConfig?.controlUIInputs, config.controlUIInputs)
                        let afterOpenRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        XCTAssertEqual(afterOpenRoute, route)
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)

                        try await self.activateLabel(String(localized: "Done"), in: ownedWindow)
                        try await self.waitUntil { hosting.presentedViewController == nil }
                        // The underlying destination must still be Settings after dismissal.
                        try await self.waitForNavigationTitle("Settings", in: ownedWindow)
                        XCTAssertNil(router.chatRegistrationID)
                        let reopened = await router.open(.session(requested))
                        XCTAssertEqual(reopened, .opened)
                        try await self.waitForComposer(in: ownedWindow)
                        XCTAssertEqual(model.chatSessionKey, requested.sessionKey)
                        XCTAssertEqual(model.chatDeliveryAgentId, requested.agentID)
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)
                        await cleanup()
                        return
                    }
                    if [.approvalDashboard, .notificationGuidance, .agentDeepLink, .gatewayTrust].contains(scenario) {
                        let config = try XCTUnwrap(model.activeGatewayConnectConfig)
                        let currentRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        let route = try XCTUnwrap(currentRoute)
                        let target = OpenClawChatSessionTarget(
                            sessionKey: model.chatSessionKey, agentID: model.chatDeliveryAgentId)
                        let selectedAgentID = model.selectedAgentId
                        let requested = OpenClawNativeSessionRef(
                            owner: session.owner, agentID: "research", sessionKey: "global")
                        let requireRefusal = {
                            let result = await router.open(.session(requested))
                            // Assert selection before the result: old code may time out behind the prompt.
                            XCTAssertEqual(
                                OpenClawChatSessionTarget(
                                    sessionKey: model.chatSessionKey, agentID: model.chatDeliveryAgentId),
                                target, "Native open changed selection behind the current prompt")
                            XCTAssertEqual(model.selectedAgentId, selectedAgentID)
                            XCTAssertEqual(result, .unavailable(
                                reason: "Finish the current screen in OpenClaw, then try again."))
                            XCTAssertTrue(model.isOperatorGatewayConnected)
                            XCTAssertEqual(model.activeGatewayConnectConfig?.controlUIInputs, config.controlUIInputs)
                            let afterOpenRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                            XCTAssertEqual(afterOpenRoute, route)
                            XCTAssertEqual(sends, 0)
                            XCTAssertEqual(creates, 0)
                        }
                        switch scenario {
                        case .approvalDashboard:
                            // SwiftUI-owned callbacks read the persisted store, not a test TaskLocal.
                            // This unique Gateway row is the only credential owned by this scenario.
                            let identity = try XCTUnwrap(DeviceIdentityStore.loadOrCreatePersisted())
                            guard DeviceAuthStore.loadToken(
                                deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID) == nil
                            else { throw OpenClawNativeActionError("Fixture Gateway already has operator credentials") }
                            approvalDeviceID = identity.deviceId
                            guard DeviceAuthStore.storeTokenPersisted(
                                deviceId: identity.deviceId, role: "operator", token: approvalToken,
                                scopes: ["operator.admin"], gatewayID: gatewayID)
                            else { throw OpenClawNativeActionError("Fixture operator credential did not persist") }
                            let stored = try XCTUnwrap(DeviceAuthStore.loadToken(
                                deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID))
                            guard stored.token == approvalToken, stored.scopes == ["operator.admin"] else {
                                throw OpenClawNativeActionError("Fixture operator credential readback did not match")
                            }
                            model.refreshOperatorAdminScopeFromStore()
                            XCTAssertTrue(model.hasOperatorAdminScope)
                            XCTAssertTrue(SettingsHubScreen.usesDashboard(
                                isOperatorConnected: model.isOperatorGatewayConnected,
                                hasOperatorAdminScope: model.hasOperatorAdminScope,
                                isDemoMode: model.isAppleReviewDemoModeEnabled,
                                isScreenshotMode: ProcessInfo.processInfo.arguments
                                    .contains("--openclaw-screenshot-mode")))
                            XCTAssertNotNil(AuthenticatedControlUI.pageURL(
                                config: config, path: "/approve/\(approvalID)", queryItems: []))
                            await model.refreshPendingApprovalInbox()
                            try await self.waitUntil {
                                model.pendingExecApprovalInboxItems.contains { $0.prompt.id == approvalID }
                            }
                            let item = try XCTUnwrap(model.pendingExecApprovalInboxItems
                                .first { $0.prompt.id == approvalID })
                            XCTAssertEqual(
                                item.prompt.attentionSource?.authorityGeneration,
                                model.operatorAuthorityGeneration)
                            XCTAssertEqual(item.prompt.attentionSource?.sessionKey, session.sessionKey)
                            XCTAssertEqual(item.prompt.attentionSource?.agentID, session.agentID)
                            model.presentPendingExecApprovalFromInbox(item.id)
                            try await self.waitUntil {
                                try self.accessibilityElement(
                                    "approval-dashboard-review",
                                    in: ownedWindow,
                                    button: true) != nil
                            }
                            await requireRefusal()
                            XCTAssertEqual(model.pendingExecApprovalPrompt, item.prompt)
                            XCTAssertNil(hosting.presentedViewController)

                            let review = try XCTUnwrap(self.accessibilityElement(
                                "approval-dashboard-review", in: ownedWindow, button: true))
                            guard review.accessibilityActivate()
                            else { throw OpenClawNativeActionError("Approval Dashboard action did not activate") }
                            try await self.waitUntil { hosting.presentedViewController?.view.window === ownedWindow }
                            try await self.waitForNavigationTitle("Review approval", in: ownedWindow)
                            let sheet = try XCTUnwrap(hosting.presentedViewController)
                            await requireRefusal()
                            XCTAssertTrue(hosting.presentedViewController === sheet)
                            XCTAssertTrue(sheet.view.window === ownedWindow)
                            XCTAssertEqual(model.pendingExecApprovalPrompt, item.prompt)

                            let done = try XCTUnwrap(self.accessibilityElement(
                                "DashboardPage.Close", in: ownedWindow, button: true))
                            guard done.accessibilityActivate()
                            else { throw OpenClawNativeActionError("Approval Dashboard Done did not activate") }
                            try await self.waitUntil { hosting.presentedViewController == nil }
                            try await self.waitUntil {
                                try self.accessibilityElement(
                                    "approval-dashboard-review",
                                    in: ownedWindow,
                                    button: true) != nil
                            }
                            await requireRefusal()
                            XCTAssertEqual(model.pendingExecApprovalPrompt, item.prompt)
                            try await self.activateLabel(String(localized: "Cancel"), in: ownedWindow)
                            try await self.waitUntil { model.pendingExecApprovalPrompt == nil }
                            XCTAssertTrue(model.pendingExecApprovalInboxItems.contains { $0.id == item.id })
                        case .notificationGuidance:
                            approvalEventTask = Task { @MainActor in
                                defer { approvalEvent.isCurrent = false }
                                await model.handleOperatorGatewayServerEvent(
                                    EventFrame(
                                        type: "event", event: ExecApprovalNotificationBridge.requestedKind,
                                        payload: OpenClawProtocol.AnyCodable(["id": approvalID]),
                                        seq: nil, stateversion: nil),
                                    expectedOperatorRoute: route,
                                    shouldContinue: { approvalEvent.isCurrent })
                            }
                            try await self.waitUntil {
                                approvalEvent.getEntered &&
                                    model.pendingNotificationPermissionGuidancePrompt?.approvalId == approvalID
                            }
                            let prompt = try XCTUnwrap(model.pendingNotificationPermissionGuidancePrompt)
                            XCTAssertNil(model.pendingExecApprovalPrompt)
                            try await self.waitUntil {
                                try self.accessibilityElement(
                                    nil, label: "Notifications are off", in: ownedWindow) != nil
                            }
                            await requireRefusal()
                            XCTAssertEqual(model.pendingNotificationPermissionGuidancePrompt?.id, prompt.id)
                            XCTAssertNil(model.pendingExecApprovalPrompt)
                            XCTAssertNotNil(try self.accessibilityElement(
                                nil, label: "Notifications are off", in: ownedWindow))
                            try await self.activateLabel(String(localized: "Not Now"), in: ownedWindow)
                            try await self.waitUntil { model.pendingNotificationPermissionGuidancePrompt == nil }
                            XCTAssertFalse(model.execApprovalNotificationGuidanceSuppressed)
                        // Keep approval.get held through the fresh positive open below.
                        case .agentDeepLink:
                            // The operator is real; this field is only the existing UI-fixture
                            // prerequisite for the deep-link producer, not proof of a node connection.
                            model.gatewayConnected = true
                            let url = try XCTUnwrap(URL(
                                string: "openclaw://agent?message=hello%20from%20deep%20link"))
                            await model.handleDeepLink(url: url)
                            let prompt = try XCTUnwrap(model.pendingAgentDeepLinkPrompt)
                            ownedDeepLinkPromptID = prompt.id
                            try await self.waitUntil {
                                (hosting.presentedViewController as? UIAlertController)?.title == "Run OpenClaw agent?"
                            }
                            let alert = try XCTUnwrap(hosting.presentedViewController as? UIAlertController)
                            XCTAssertTrue(alert.view.window === ownedWindow)
                            await requireRefusal()
                            XCTAssertEqual(model.pendingAgentDeepLinkPrompt, prompt)
                            XCTAssertTrue(hosting.presentedViewController === alert)
                            try await self.activateLabel(String(localized: "Cancel"), in: ownedWindow)
                            try await self.waitUntil {
                                model.pendingAgentDeepLinkPrompt == nil && hosting.presentedViewController == nil
                            }
                            model.gatewayConnected = originalNodeConnected
                        case .gatewayTrust:
                            guard GatewayTLSStore.loadFingerprint(stableID: trustGatewayID) == nil else {
                                throw OpenClawNativeActionError("Fixture Gateway already has a TLS fingerprint")
                            }
                            let discovered = GatewayDiscoveryModel.DiscoveredGateway(
                                name: "Visual trust fixture",
                                endpoint: .service(
                                    name: "Visual trust fixture", type: "_openclaw-gw._tcp",
                                    domain: "local.", interface: nil),
                                stableID: trustGatewayID, debugID: "visual-trust-fixture",
                                lanHost: nil, tailnetDns: nil, gatewayPort: nil,
                                tlsEnabled: true, tlsFingerprintSha256: nil, cliPath: nil)
                            let connectionError = await controller.connectWithDiagnostics(discovered)
                            XCTAssertNil(connectionError)
                            let prompt = try XCTUnwrap(controller.pendingTrustPrompt)
                            ownedTrustPrompt = prompt
                            XCTAssertEqual(prompt.stableID, trustGatewayID)
                            try await self.waitUntil {
                                (hosting.presentedViewController as? UIAlertController)?.title == "Trust this gateway?"
                            }
                            let alert = try XCTUnwrap(hosting.presentedViewController as? UIAlertController)
                            XCTAssertTrue(alert.view.window === ownedWindow)
                            await requireRefusal()
                            XCTAssertEqual(controller.pendingTrustPrompt, prompt)
                            XCTAssertTrue(hosting.presentedViewController === alert)
                            try await self.activateLabel(String(localized: "Cancel"), in: ownedWindow)
                            try await self.waitUntil {
                                controller.pendingTrustPrompt == nil && !controller.hasPendingConnectionHandoff &&
                                    hosting.presentedViewController == nil
                            }
                            XCTAssertNil(GatewayTLSStore.loadFingerprint(stableID: trustGatewayID))
                        default:
                            break
                        }
                        XCTAssertEqual(
                            OpenClawChatSessionTarget(
                                sessionKey: model.chatSessionKey, agentID: model.chatDeliveryAgentId), target)
                        XCTAssertEqual(model.selectedAgentId, selectedAgentID)
                        XCTAssertEqual(model.activeGatewayConnectConfig?.controlUIInputs, config.controlUIInputs)
                        let afterDismissRoute = await model.operatorSession.currentRoute(ifGatewayID: gatewayID)
                        XCTAssertEqual(afterDismissRoute, route)
                        try await self.waitForNavigationTitle("Settings", in: ownedWindow)
                        let reopened = await router.open(.session(requested))
                        XCTAssertEqual(reopened, .opened)
                        try await self.waitForComposer(in: ownedWindow)
                        XCTAssertEqual(model.chatSessionKey, requested.sessionKey)
                        XCTAssertEqual(model.chatDeliveryAgentId, requested.agentID)
                        if scenario == .approvalDashboard {
                            XCTAssertTrue(model.pendingExecApprovalInboxItems.contains { $0.prompt.id == approvalID })
                        }
                        XCTAssertEqual(sends, 0)
                        XCTAssertEqual(creates, 0)
                        await cleanup()
                        return
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
                        let inspected = try await router.inspect(run).inspection
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
                    case .inspection, .inspectionDone, .inspectionEscape, .inspectionReplacement,
                         .nativeFromSettingsPath, .nativeAfterUserChat, .sidebarFork, .sidebarNewChat, .gatewayDetails,
                         .sidebarNewChatProtected, .sidebarNewChatOrdinary,
                         .approvalDashboard, .notificationGuidance, .agentDeepLink, .gatewayTrust,
                         .nativeForkCanonical, .nativeForkOpaque, .nativeForkNavigation, .nativeForkAccountABA,
                         .nativeForkRoute, .nativeCreateAccountABA,
                         .nativeOpenAccountABA, .nativeInspectAccountABA, .nativePreparedSendAccountABA,
                         .chatModalAdmissionApp, .chatModalAdmissionShared, .chatModalHeldOpenApp,
                         .chatModalHeldOpenShared, .chatModalHeldInspectApp, .chatModalHeldInspectShared,
                         .chatModalHeldPrepareApp, .chatModalHeldPrepareShared, .chatModalPreparedApp,
                         .chatModalPreparedShared, .chatModalNewOptionsCover, .chatModalRemovalApp,
                         .chatModalRemovalShared,
                         .pagesAdmission, .pagesAdmissionCover, .pagesHeldOpen, .pagesHeldInspect, .pagesHeldPrepare,
                         .pagesPrepared, .pagesRemoval:
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
                let inspection = try await router.inspect(run).inspection
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

    @MainActor
    private final class ApprovalEventState {
        var isCurrent = true
        var getEntered = false
    }

    private struct DeniedVisualNotificationCenter: NotificationCentering {
        func authorizationStatus() async -> NotificationAuthorizationStatus {
            .denied
        }

        func add(_ request: UNNotificationRequest) async throws {
            throw OpenClawNativeActionError("Visual fixture must not post notifications")
        }

        func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {}
        func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {}
        func deliveredNotifications() async -> [NotificationSnapshot] {
            []
        }
    }

    private func approvalResponses(
        id: String,
        session: OpenClawNativeSessionRef) throws -> (pending: String, terminal: String, resolve: String, list: String)
    {
        let presentation = ApprovalPresentation.systemAgent(SystemAgentApprovalPresentation(
            kind: "system-agent", title: "Review configuration change", description: "Update the proposed setting.",
            proposalhash: "visual-proposal", agentid: OpenClawProtocol.AnyCodable(session.agentID),
            alloweddecisions: [OpenClawProtocol.AnyCodable("allow-once"), OpenClawProtocol.AnyCodable("deny")]))
        let pending = PendingApprovalSnapshot(
            id: id, urlpath: "/approve/\(id)", createdatms: 100, expiresatms: 4_000_000_000_000,
            presentation: presentation, status: "pending", sourcesessionkey: session.sessionKey)
        let denied = DeniedApprovalSnapshot(
            id: id, urlpath: "/approve/\(id)", createdatms: 100, expiresatms: 4_000_000_000_000,
            presentation: presentation, resolvedatms: 200, status: "denied", decision: "deny", reason: .user)
        let encoder = JSONEncoder()
        return try (
            String(decoding: encoder.encode(ApprovalGetResult(approval: .pending(pending))), as: UTF8.self),
            String(decoding: encoder.encode(ApprovalGetResult(approval: .denied(denied))), as: UTF8.self),
            String(
                decoding: encoder.encode(ApprovalResolveResult(applied: false, approval: .denied(denied))),
                as: UTF8.self),
            String(decoding: JSONSerialization.data(withJSONObject: [[
                "id": id, "approvalKind": "system-agent",
                "request": ["sessionKey": session.sessionKey, "agentId": session.agentID],
                "createdAtMs": 100, "expiresAtMs": 4_000_000_000_000,
            ]]), as: UTF8.self))
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

    private func waitForComposer(in window: UIWindow, expectedText: String = "") async throws {
        // Router readiness precedes UIKit materialization. Capture only after the
        // owned window contains the actual editor with this scenario's expected text.
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
                (input.text ?? "").utf8.elementsEqual(expectedText.utf8)
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
